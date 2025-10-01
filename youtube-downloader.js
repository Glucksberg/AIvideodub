import { spawn } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Quality options for YouTube download
const QUALITY_OPTIONS = {
  '1': { name: 'Original 🌟 (Melhor qualidade disponível)', format: 'bestvideo+bestaudio/best' },
  '2': { name: '1080p 📺 (Full HD)', format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
  '3': { name: '720p 💻 (HD)', format: 'bestvideo[height<=720]+bestaudio/best[height<=720]' },
  '4': { name: '480p 📱 (SD)', format: 'bestvideo[height<=480]+bestaudio/best[height<=480]' },
  '5': { name: '360p 📞 (Baixa)', format: 'bestvideo[height<=360]+bestaudio/best[height<=360]' }
};

async function downloadYouTubeVideo(url, formatOption, outputFolder = 'downloads', options = {}) {
  console.log('\n🚀 Iniciando download do YouTube...\n');

  // Create downloads folder if it doesn't exist
  if (!fs.existsSync(outputFolder)) {
    fs.mkdirSync(outputFolder);
  }

  const args = [
    url,
    '-f', formatOption,
    '--merge-output-format', 'mp4',
    '-N', '10', // 10 parallel connections for faster download
    '--progress',
    '--newline',
    '-o', `${outputFolder}/%(title)s.%(ext)s`
  ];
  
  // Add cookies - file takes priority
  if (options.cookieFile) {
    console.log(`🍪 Usando arquivo de cookies: ${options.cookieFile}...\n`);
    args.push('--cookies', options.cookieFile);
  } else if (options.useCookies && options.browser) {
    console.log(`🍪 Usando cookies do ${options.browser}...\n`);
    args.push('--cookies-from-browser', options.browser);
  } else {
    console.log('🔓 Tentando download sem cookies...\n');
  }

  const ytdlp = spawn('yt-dlp', args);

  let outputFile = '';
  let lastProgress = '';

  ytdlp.stdout.on('data', (data) => {
    const output = data.toString();
    
    // Show progress
    if (output.includes('[download]')) {
      // Clear previous line and show new progress
      process.stdout.write('\r' + output.trim());
      lastProgress = output;
    } else {
      process.stdout.write(output);
    }
    
    // Capture the output filename
    const mergeMatch = output.match(/\[Merger\] Merging formats into "(.+?)"/);
    if (mergeMatch) {
      outputFile = mergeMatch[1];
    }
    
    const destMatch = output.match(/\[download\] Destination: (.+\.mp4)/);
    if (destMatch) {
      outputFile = destMatch[1];
    }
  });

  ytdlp.stderr.on('data', (data) => {
    const output = data.toString();
    // Only show actual errors, not info messages
    if (output.includes('ERROR')) {
      process.stderr.write('\n' + output);
    }
  });

  return new Promise((resolve, reject) => {
    ytdlp.on('close', (code) => {
      if (code === 0) {
        console.log('\n\n✅ Download concluído com sucesso!\n');
        
        // If we couldn't capture the filename, find the latest file
        if (!outputFile) {
          const files = fs.readdirSync(outputFolder)
            .filter(file => file.endsWith('.mp4'))
            .map(file => ({
              name: file,
              path: `${outputFolder}/${file}`,
              time: fs.statSync(`${outputFolder}/${file}`).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);
          
          if (files.length > 0) {
            outputFile = files[0].path;
          }
        }
        
        if (outputFile) {
          console.log(`📹 Arquivo salvo: ${outputFile}\n`);
        }
        
        resolve(outputFile);
      } else {
        console.error(`\n❌ Erro no download. Código: ${code}\n`);
        reject(new Error(`Download falhou com código ${code}`));
      }
    });
  });
}

async function selectQuality() {
  console.log('\n📊 Escolha a qualidade do download:\n');
  Object.entries(QUALITY_OPTIONS).forEach(([key, { name }]) => {
    console.log(`  ${key}. ${name}`);
  });

  const choice = await question('\n🔢 Digite o número da opção: ');
  const selected = QUALITY_OPTIONS[choice];

  if (!selected) {
    console.log('❌ Opção inválida!');
    return null;
  }

  console.log(`✨ Qualidade selecionada: ${selected.name}\n`);
  return selected.format;
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🎥 YOUTUBE VIDEO DOWNLOADER 📥      ║');
  console.log('║   Download rápido e fácil! ⚡         ║');
  console.log('╚════════════════════════════════════════╝\n');
  
  console.log('🍪 Configuração de cookies:\n');
  console.log('   1. Arquivo de cookies exportado (recomendado!)');
  console.log('   2. Chrome (tentativa direta - pode falhar)');
  console.log('   3. Firefox');
  console.log('   4. Edge');
  console.log('   5. Sem cookies (limitado)\n');
  
  const cookieChoice = await question('🔢 Escolha uma opção (Enter=Arquivo): ');
  let useCookies = true;
  let browser = 'chrome';
  let cookieFile = null;
  
  if (cookieChoice === '1' || cookieChoice === '') {
    // Cookie file
    console.log('\n📋 INSTRUÇÕES PARA EXPORTAR COOKIES:\n');
    console.log('1. Instale a extensão "Get cookies.txt LOCALLY" no seu navegador:');
    console.log('   Chrome: https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc');
    console.log('   Firefox: https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/');
    console.log('\n2. Vá para youtube.com e faça login');
    console.log('3. Clique na extensão e escolha "Export"');
    console.log('4. Salve o arquivo como "youtube_cookies.txt" nesta pasta\n');
    
    const hasCookies = await question('Você já exportou os cookies? (s/n): ');
    
    if (hasCookies.toLowerCase() === 's') {
      const fileName = await question('Nome do arquivo (Enter=youtube_cookies.txt): ');
      cookieFile = fileName.trim() || 'youtube_cookies.txt';
      
      if (!fs.existsSync(cookieFile)) {
        console.log(`\n❌ Arquivo "${cookieFile}" não encontrado!`);
        console.log('Por favor, exporte os cookies primeiro.\n');
        rl.close();
        return;
      }
      
      console.log(`✅ Usando arquivo de cookies: ${cookieFile}\n`);
      browser = null;
    } else {
      console.log('\n⚠️  Por favor, exporte os cookies primeiro e rode o script novamente.\n');
      rl.close();
      return;
    }
    
  } else if (cookieChoice === '2') {
    browser = 'chrome';
  } else if (cookieChoice === '3') {
    browser = 'firefox';
  } else if (cookieChoice === '4') {
    browser = 'edge';
  } else if (cookieChoice === '5') {
    useCookies = false;
    browser = null;
  }
  
  if (useCookies && browser) {
    const browserNames = {
      'chrome': 'Chrome',
      'firefox': 'Firefox',
      'edge': 'Edge'
    };
    const browserName = browserNames[browser];
    
    console.log(`\n✅ Usando cookies do ${browserName}`);
    console.log(`⚠️  IMPORTANTE: Feche o ${browserName} COMPLETAMENTE!\n`);
    console.log(`   - Feche todas as janelas`);
    console.log(`   - Verifique a bandeja do sistema (ícone perto do relógio)`);
    console.log(`   - Se houver ${browserName} em background, feche também\n`);
    await question(`Pressione Enter quando o ${browserName} estiver totalmente fechado...`);
    console.log('');
  } else if (!useCookies) {
    console.log('⚠️  Modo sem cookies (pode ter rate limiting)\n');
  }

  const continueDownloading = true;

  while (continueDownloading) {
    console.log('🎯 O que você deseja fazer?\n');
    console.log('  1. 📥 Baixar vídeo do YouTube');
    console.log('  2. 📋 Baixar múltiplos vídeos (lista)');
    console.log('  3. 🚪 Sair\n');

    const mainChoice = await question('🔢 Digite o número da opção: ');

    if (mainChoice === '1') {
      // Single video download
      console.log('\n🌐 === DOWNLOAD DE VÍDEO ===\n');

      const url = await question('📎 Cole a URL do vídeo do YouTube: ');

      if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        console.log('❌ URL inválida! Use uma URL do YouTube.\n');
        continue;
      }

      const quality = await selectQuality();
      if (!quality) {
        continue;
      }

      try {
        await downloadYouTubeVideo(url, quality, 'downloads', { useCookies, browser, cookieFile });
        console.log('🎉 Download concluído!\n');
      } catch (error) {
        console.error('❌ Erro no download:', error.message, '\n');
      }

    } else if (mainChoice === '2') {
      // Multiple videos download
      console.log('\n📋 === DOWNLOAD DE MÚLTIPLOS VÍDEOS ===\n');
      console.log('Cole as URLs dos vídeos (uma por linha).');
      console.log('Digite "FIM" quando terminar:\n');

      const urls = [];
      while (true) {
        const url = await question('URL (ou "FIM"): ');
        if (url.toUpperCase() === 'FIM') break;
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
          urls.push(url);
        } else if (url.trim()) {
          console.log('⚠️  URL inválida, ignorando...');
        }
      }

      if (urls.length === 0) {
        console.log('❌ Nenhuma URL válida fornecida.\n');
        continue;
      }

      console.log(`\n📊 Total de vídeos: ${urls.length}\n`);

      const quality = await selectQuality();
      if (!quality) {
        continue;
      }

      console.log('🚀 Iniciando downloads...\n');

      for (let i = 0; i < urls.length; i++) {
        console.log(`\n📹 Download ${i + 1}/${urls.length}`);
        console.log(`🔗 ${urls[i]}\n`);
        
        try {
          await downloadYouTubeVideo(urls[i], quality, 'downloads', { useCookies, browser, cookieFile });
        } catch (error) {
          console.error(`❌ Erro no vídeo ${i + 1}:`, error.message);
          console.log('⏭️  Continuando para o próximo...\n');
        }
      }

      console.log('\n🎉 Todos os downloads concluídos!\n');

    } else if (mainChoice === '3') {
      console.log('\n👋 Até logo!\n');
      rl.close();
      break;
    } else {
      console.log('❌ Opção inválida!\n');
    }

    const continueChoice = await question('\n🔄 Deseja baixar mais vídeos? (s/n): ');
    if (continueChoice.toLowerCase() !== 's') {
      console.log('\n👋 Até logo!\n');
      rl.close();
      break;
    }
  }
}

main().catch(error => {
  console.error('❌ Erro fatal:', error.message);
  process.exit(1);
});
