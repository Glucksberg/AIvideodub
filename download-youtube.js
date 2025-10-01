import { spawn } from 'child_process';
import { createInterface } from 'readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const QUALITY_OPTIONS = {
  '1': { name: 'Original (Melhor qualidade disponível)', format: 'bestvideo+bestaudio/best' },
  '2': { name: '1080p (Full HD)', format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
  '3': { name: '720p (HD)', format: 'bestvideo[height<=720]+bestaudio/best[height<=720]' },
  '4': { name: '480p (SD)', format: 'bestvideo[height<=480]+bestaudio/best[height<=480]' },
  '5': { name: '360p (Baixa)', format: 'bestvideo[height<=360]+bestaudio/best[height<=360]' }
};

async function downloadVideo(url, formatOption) {
  console.log('\n🚀 Iniciando download...\n');

  const args = [
    url,
    '-f', formatOption,
    '--merge-output-format', 'mp4',
    '-N', '10',
    '--progress',
    '--newline',
    '-o', '%(title)s.%(ext)s'
  ];

  const ytdlp = spawn('yt-dlp', args);

  ytdlp.stdout.on('data', (data) => {
    process.stdout.write(data.toString());
  });

  ytdlp.stderr.on('data', (data) => {
    process.stderr.write(data.toString());
  });

  return new Promise((resolve, reject) => {
    ytdlp.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ Download concluído com sucesso!');
        resolve();
      } else {
        console.error(`\n❌ Erro no download. Código: ${code}`);
        reject(new Error(`yt-dlp falhou com código ${code}`));
      }
    });
  });
}

async function main() {
  console.log('🎥 YouTube Video Downloader\n');
  
  const url = await question('Cole a URL do vídeo do YouTube: ');
  
  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    console.log('❌ URL inválida! Use uma URL do YouTube.');
    rl.close();
    return;
  }

  console.log('\n📊 Escolha a qualidade:\n');
  Object.entries(QUALITY_OPTIONS).forEach(([key, { name }]) => {
    console.log(`  ${key}. ${name}`);
  });

  const choice = await question('\nDigite o número da opção desejada: ');

  const selectedOption = QUALITY_OPTIONS[choice];
  
  if (!selectedOption) {
    console.log('❌ Opção inválida!');
    rl.close();
    return;
  }

  console.log(`\n✨ Qualidade selecionada: ${selectedOption.name}`);
  
  rl.close();

  try {
    await downloadVideo(url, selectedOption.format);
  } catch (error) {
    console.error('Erro:', error.message);
    process.exit(1);
  }
}

main();
