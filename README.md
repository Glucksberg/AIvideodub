# 🎬 Video Dubbing Tool - PT-BR para Inglês

Ferramenta automatizada para dublagem de vídeos de Português Brasileiro para Inglês usando a API da OpenAI.

## 📋 Índice

- [Visão Geral](#visão-geral)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Como Usar](#como-usar)
- [Explicação do Código](#explicação-do-código)
- [Pontos de Melhoria](#pontos-de-melhoria)
- [Troubleshooting](#troubleshooting)

## 🎯 Visão Geral

Este projeto automatiza o processo de dublagem de vídeos, realizando as seguintes etapas:

1. **Extração de áudio** do vídeo original
2. **Transcrição** do áudio em português usando `gpt-4o-mini-transcribe`
3. **Tradução** do texto português para inglês usando `o4-mini`
4. **Geração de áudio** em inglês usando `gpt-4o-mini-tts`
5. **Ajuste automático** da velocidade do áudio para sincronizar com o vídeo
6. **Substituição** do áudio original pelo áudio dublado

## 📦 Requisitos

### Software Necessário

- **Node.js** v14+ (testado com v22.17.0)
- **FFmpeg** (para manipulação de áudio/vídeo)
- **Conta OpenAI** com acesso aos seguintes modelos:
  - `gpt-4o-mini-transcribe`
  - `o4-mini`
  - `gpt-4o-mini-tts`

### Dependências Node.js

```json
{
  "openai": "^5.23.2",
  "dotenv": "^17.2.3"
}
```

## 🚀 Instalação

1. Clone ou baixe o projeto:
```bash
cd /caminho/para/novo_projeto_luna
```

2. Instale as dependências:
```bash
npm install
```

3. Verifique se o FFmpeg está instalado:
```bash
ffmpeg -version
```

## ⚙️ Configuração

### 1. Configurar API Key da OpenAI

Crie um arquivo `.env` na raiz do projeto:

```bash
OPENAI_API_KEY=sk-sua-chave-aqui
```

**No Windows (Notepad):**
1. Abra o Notepad
2. Digite: `OPENAI_API_KEY=sk-sua-chave-aqui`
3. File → Save As
4. Nome: `.env` (com aspas)
5. Save as type: "All Files"

### 2. Adicionar seu vídeo

Coloque seu arquivo `.mp4` na pasta do projeto ou edite o caminho no arquivo `dub-video.js`:

```javascript
const inputVideo = 'seu-video.mp4';
const outputVideo = 'seu-video_english.mp4';
```

## 🎮 Como Usar

Execute o script com:

```bash
npm run dub
```

O processo levará alguns minutos dependendo do tamanho do vídeo. Você verá o progresso no terminal:

```
🎬 Starting video dubbing process...
📤 Extracting audio from video...
✅ Audio extracted
🎙️  Transcribing Portuguese audio...
✅ Portuguese transcription: ...
🌐 Translating to English...
✅ English translation: ...
🔊 Generating English speech...
✅ English audio generated
⏱️  Checking video/audio duration...
🎥 Replacing audio in video...
✅ Video with English dub created
🧹 Cleaning up temporary files...
🎉 Done! Your dubbed video is ready: ruicostapimenta_english.mp4
```

## 🔍 Explicação do Código

### Estrutura do Arquivo `dub-video.js`

#### 1. Imports e Configuração Inicial

```javascript
import 'dotenv/config';        // Carrega variáveis do .env
import OpenAI from 'openai';   // Cliente da API OpenAI
import fs from 'fs';           // Sistema de arquivos
import { exec } from 'child_process';  // Execução de comandos shell
import { promisify } from 'util';      // Converte callbacks em Promises

const execAsync = promisify(exec);  // Versão async do exec

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
```

#### 2. Função Principal `dubVideo()`

##### **Step 1: Extração de Áudio**

```javascript
const audioFile = 'temp_audio.mp3';
await execAsync(`ffmpeg -i "${inputVideo}" -vn -acodec libmp3lame -q:a 2 "${audioFile}" -y`);
```

- `-i "${inputVideo}"`: arquivo de entrada
- `-vn`: sem vídeo (apenas áudio)
- `-acodec libmp3lame`: codec MP3
- `-q:a 2`: qualidade de áudio (0-9, menor = melhor)
- `-y`: sobrescrever arquivo existente

##### **Step 2: Transcrição do Áudio**

```javascript
const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(audioFile),
  model: 'gpt-4o-mini-transcribe',
  language: 'pt'
});
```

- Usa o modelo `gpt-4o-mini-transcribe` para converter áudio em texto
- `language: 'pt'` especifica português
- Retorna objeto com `text` contendo a transcrição

##### **Step 3: Tradução**

```javascript
const translationResponse = await openai.chat.completions.create({
  model: 'o4-mini',
  messages: [
    {
      role: 'system',
      content: 'You are a professional translator. Translate the following Portuguese text to English. Keep the same tone and style. Only return the translated text, nothing else.'
    },
    {
      role: 'user',
      content: transcription.text
    }
  ]
});
const englishText = translationResponse.choices[0].message.content;
```

- Usa `o4-mini` para tradução contextual
- Mantém tom e estilo original
- Sistema de mensagens permite controle fino da tradução

##### **Step 4: Geração de Áudio em Inglês**

```javascript
const speechResponse = await openai.audio.speech.create({
  model: 'gpt-4o-mini-tts',
  voice: 'onyx',
  input: englishText,
});

const buffer = Buffer.from(await speechResponse.arrayBuffer());
fs.writeFileSync(englishAudioFile, buffer);
```

- `gpt-4o-mini-tts`: modelo de text-to-speech
- Vozes disponíveis: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`
- Converte resposta em buffer e salva como MP3

##### **Step 5: Ajuste de Velocidade**

```javascript
const videoDuration = parseFloat(videoInfo.trim());
const audioDuration = parseFloat(audioInfo.trim());
const speedRatio = videoDuration / audioDuration;

if (Math.abs(speedRatio - 1) > 0.05) {
  audioFilter = `-filter:a "atempo=${speedRatio}"`;
}
```

- Calcula duração de vídeo e áudio usando `ffprobe`
- Ajusta velocidade apenas se diferença > 5%
- `atempo`: filtro FFmpeg para ajustar tempo sem alterar pitch

##### **Step 6: Substituição de Áudio**

```javascript
await execAsync(`ffmpeg -i "${inputVideo}" -i "${englishAudioFile}" -c:v copy ${audioFilter} -map 0:v:0 -map 1:a:0 -shortest "${outputVideo}" -y`);
```

- `-c:v copy`: copia stream de vídeo sem recodificar (rápido)
- `-map 0:v:0`: usa vídeo do primeiro input
- `-map 1:a:0`: usa áudio do segundo input
- `-shortest`: corta no stream mais curto

##### **Step 7: Limpeza**

```javascript
fs.unlinkSync(audioFile);
fs.unlinkSync(englishAudioFile);
```

Remove arquivos temporários após conclusão.

#### 3. Tratamento de Erros

```javascript
dubVideo(inputVideo, outputVideo).catch(error => {
  console.error('❌ Error:', error.message);

  // Cleanup on error
  try {
    if (fs.existsSync('temp_audio.mp3')) fs.unlinkSync('temp_audio.mp3');
    if (fs.existsSync('english_audio.mp3')) fs.unlinkSync('english_audio.mp3');
  } catch (e) {}

  process.exit(1);
});
```

Garante limpeza de arquivos temporários mesmo em caso de erro.

## 🚀 Pontos de Melhoria

### 1. **Suporte a Múltiplos Vídeos**

**Problema atual:** Só processa um vídeo por vez

**Solução:**
```javascript
const videos = ['video1.mp4', 'video2.mp4', 'video3.mp4'];

for (const video of videos) {
  const output = video.replace('.mp4', '_english.mp4');
  await dubVideo(video, output);
}
```

### 2. **Sincronização de Lábios (Lip Sync)**

**Problema atual:** Áudio é apenas ajustado em velocidade global

**Soluções possíveis:**
- Usar bibliotecas de detecção de fala para mapear timestamps
- Implementar algoritmo de time-stretching mais sofisticado
- Usar ferramentas como Wav2Lip ou Speech-Driven 3D Facial Animation

### 3. **Preservação de Música e Sons Ambiente**

**Problema atual:** Todo o áudio original é substituído

**Solução:**
```javascript
// Separar voz de música/sons usando spleeter ou demucs
await execAsync('demucs --two-stems=vocals temp_audio.mp3');

// Mixar voz dublada com música/sons originais
await execAsync(`ffmpeg -i vocals.mp3 -i background.mp3 -filter_complex amix=inputs=2 mixed.mp3`);
```

### 4. **Cache de Traduções**

**Problema atual:** Mesmos trechos são traduzidos múltiplas vezes

**Solução:**
```javascript
const cache = {};

function translateWithCache(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');

  if (cache[hash]) {
    return cache[hash];
  }

  const translation = await translateText(text);
  cache[hash] = translation;
  return translation;
}
```

### 5. **Escolha de Voz por Gênero**

**Problema atual:** Usa sempre a voz "onyx"

**Solução:**
```javascript
// Detectar gênero do falante original
const voiceMap = {
  male: 'onyx',    // voz masculina
  female: 'nova',  // voz feminina
};

// Ou permitir escolha via CLI
const voice = process.argv[2] || 'onyx';
```

### 6. **Interface de Linha de Comando (CLI)**

**Solução:**
```javascript
import { program } from 'commander';

program
  .option('-i, --input <file>', 'Input video file')
  .option('-o, --output <file>', 'Output video file')
  .option('-v, --voice <voice>', 'TTS voice (alloy, echo, fable, onyx, nova, shimmer)')
  .option('-l, --language <lang>', 'Source language (default: pt)');

program.parse();
const options = program.opts();
```

### 7. **Progress Bar**

**Solução:**
```javascript
import cliProgress from 'cli-progress';

const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
progressBar.start(100, 0);
// Atualizar em cada etapa
progressBar.update(20); // Extração completa
progressBar.update(40); // Transcrição completa
// ...
progressBar.stop();
```

### 8. **Suporte a Legendas (SRT)**

**Adicionar geração de legendas:**
```javascript
// Usar timestamps da transcrição para gerar SRT
function generateSRT(transcription) {
  // Formato SRT:
  // 1
  // 00:00:00,000 --> 00:00:05,000
  // Texto da legenda
}
```

### 9. **Otimização de Custos**

**Problema atual:** Não há controle sobre custos da API

**Soluções:**
- Implementar estimativa de custo antes da execução
- Usar modelos menores para vídeos longos
- Cache agressivo de resultados

### 10. **Qualidade de Áudio Configurável**

**Adicionar opções de qualidade:**
```javascript
const quality = {
  low: { model: 'tts-1', bitrate: '64k' },
  medium: { model: 'tts-1', bitrate: '128k' },
  high: { model: 'tts-1-hd', bitrate: '320k' },
};
```

### 11. **Suporte a Outros Idiomas**

**Expandir para outras combinações:**
```javascript
const languagePairs = {
  'pt-en': { from: 'pt', to: 'en' },
  'en-pt': { from: 'en', to: 'pt' },
  'es-en': { from: 'es', to: 'en' },
  // ...
};
```

### 12. **Processamento em Lote com Fila**

**Para múltiplos vídeos:**
```javascript
import Bull from 'bull';

const videoQueue = new Bull('video-dubbing');

videoQueue.process(async (job) => {
  const { inputVideo, outputVideo } = job.data;
  await dubVideo(inputVideo, outputVideo);
});

// Adicionar vídeos à fila
videoQueue.add({ inputVideo: 'video1.mp4', outputVideo: 'video1_en.mp4' });
```

## 🐛 Troubleshooting

### Erro: "Project does not have access to model"

**Solução:** Verifique se sua conta OpenAI tem acesso aos modelos necessários e se possui créditos disponíveis.

### Erro: "OPENAI_API_KEY not found"

**Solução:** Certifique-se de que o arquivo `.env` está na raiz do projeto e contém a chave correta.

### FFmpeg não encontrado

**Solução no Windows:**
1. Baixe FFmpeg de https://ffmpeg.org/download.html
2. Adicione ao PATH do sistema
3. Reinicie o terminal

### Áudio dessincronizado

**Solução:** Ajuste o threshold de sincronização no código:
```javascript
if (Math.abs(speedRatio - 1) > 0.02) {  // Mais sensível
```

### Vídeo muito grande

**Solução:** Comprima o vídeo antes:
```bash
ffmpeg -i input.mp4 -vcodec h264 -acodec aac compressed.mp4
```

## 📝 Licença

ISC

## 👤 Autor

Projeto criado para dublagem automatizada de vídeos.

---

**Nota:** Este projeto usa serviços pagos da OpenAI. Monitore seus custos em https://platform.openai.com/usage# Test commit from WSL
