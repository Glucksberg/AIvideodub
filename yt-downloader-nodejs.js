import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import { createInterface } from 'readline';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Quality options
const QUALITY_OPTIONS = {
  '1': { name: 'Original 🌟 (Melhor qualidade)', quality: 'highestvideo', audioQuality: 'highestaudio' },
  '2': { name: '1080p 📺 (Full HD)', quality: '1080p', audioQuality: 'highestaudio' },
  '3': { name: '720p 💻 (HD)', quality: '720p', audioQuality: 'highestaudio' },
  '4': { name: '480p 📱 (SD)', quality: '480p', audioQuality: 'highestaudio' },
  '5': { name: '360p 📞 (Baixa)', quality: '360p', audioQuality: 'highestaudio' }
};

async function downloadVideo(url, qualityOption) {
  console.log('\n🚀 Iniciando download...\n');

  // Create downloads folder
  if (!fs.existsSync('downloads')) {
    fs.mkdirSync('downloads');
  }

  try {
    // Get video info
    console.log('📊 Obtendo informações do vídeo...');
    const info = await ytdl.getInfo(url);
    const videoTitle = info.videoDetails.title.replace(/[<>:"/\\|?*]/g, '_');
    
    console.log(`✅ Título: ${info.videoDetails.title}`);
    console.log(`⏱️  Duração: ${Math.floor(info.videoDetails.lengthSeconds / 60)}:${(info.videoDetails.lengthSeconds % 60).toString().padStart(2, '0')}`);
    console.log(`👁️  Views: ${parseInt(info.videoDetails.viewCount).toLocaleString()}\n`);

    const outputPath = `downloads/${videoTitle}.mp4`;
    const videoPath = `downloads/${videoTitle}_video.mp4`;
    const audioPath = `downloads/${videoTitle}_audio.mp4`;

    // Download video and audio separately, then merge with ffmpeg
    console.log('📥 Baixando vídeo e áudio...\n');
    
    // Download video
    console.log('🎬 Baixando stream de vídeo...');
    const videoStream = ytdl(url, {
      quality: qualityOption.quality === 'highestvideo' ? 'highestvideo' : qualityOption.quality,
      filter: 'videoonly'
    });

    const videoWriteStream = fs.createWriteStream(videoPath);
    videoStream.pipe(videoWriteStream);

    await new Promise((resolve, reject) => {
      videoWriteStream.on('finish', () => {
        console.log('✅ Vídeo baixado\n');
        resolve();
      });
      videoWriteStream.on('error', reject);
      videoStream.on('error', reject);
    });

    // Download audio
    console.log('🎵 Baixando stream de áudio...');
    const audioStream = ytdl(url, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    const audioWriteStream = fs.createWriteStream(audioPath);
    audioStream.pipe(audioWriteStream);

    await new Promise((resolve, reject) => {
      audioWriteStream.on('finish', () => {
        console.log('✅ Áudio baixado\n');
        resolve();
      });
      audioWriteStream.on('error', reject);
      audioStream.on('error', reject);
    });

    // Merge video and audio using ffmpeg
    console.log('🔗 Combinando vídeo e áudio com ffmpeg...');
    await execAsync(`ffmpeg -i "${videoPath}" -i "${audioPath}" -c copy "${outputPath}" -y`);
    console.log('✅ Arquivos combinados\n');

    // Cleanup temp files
    fs.unlinkSync(videoPath);
    fs.unlinkSync(audioPath);

    console.log('✅ Download concluído com sucesso!\n');
    console.log(`📹 Arquivo salvo: ${outputPath}\n`);
    
    return outputPath;

  } catch (error) {
    console.error('\n❌ Erro:', error.message);
    
    if (error.message.includes('Sign in')) {
      console.log('\n⚠️  Este vídeo requer autenticação.');
      console.log('Possíveis causas:');
      console.log('   - Vídeo privado ou restrito por idade');
      console.log('   - Limitação geográfica');
      console.log('   - Proteção anti-bot do YouTube\n');
    }
    
    throw error;
  }
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
  return selected;
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🎥 YOUTUBE DOWNLOADER (Node.js) 📥  ║');
  console.log('║   Sem necessidade de cookies! ✨      ║');
  console.log('╚════════════════════════════════════════╝\n');

  while (true) {
    console.log('🎯 O que você deseja fazer?\n');
    console.log('  1. 📥 Baixar vídeo do YouTube');
    console.log('  2. 🚪 Sair\n');

    const mainChoice = await question('🔢 Digite o número da opção: ');

    if (mainChoice === '1') {
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
        await downloadVideo(url, quality);
        console.log('🎉 Vídeo baixado com sucesso!\n');
      } catch (error) {
        console.error('❌ Falha no download\n');
      }

    } else if (mainChoice === '2') {
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
  rl.close();
  process.exit(1);
});
