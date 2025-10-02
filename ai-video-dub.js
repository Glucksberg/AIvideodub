import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';

const execAsync = promisify(exec);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Maximum characters per TTS request (OpenAI limit is 4096)
const MAX_TTS_CHARS = 4000;

// Maximum file size for Whisper API (25MB limit)
const MAX_WHISPER_FILE_SIZE = 24 * 1024 * 1024; // 24MB to be safe

// Chunk duration for splitting long audio files (in seconds)
const AUDIO_CHUNK_DURATION = 300; // 5 minutes per chunk

// Helper function to split text into chunks intelligently
function splitTextIntoChunks(text, maxChars = MAX_TTS_CHARS) {
  const chunks = [];
  
  // Split by sentences first
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  let currentChunk = '';
  
  for (const sentence of sentences) {
    // If single sentence is too long, split by commas or spaces
    if (sentence.length > maxChars) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      
      // Split long sentence by commas
      const parts = sentence.split(',');
      for (const part of parts) {
        if ((currentChunk + part).length <= maxChars) {
          currentChunk += part + ',';
        } else {
          if (currentChunk) chunks.push(currentChunk.trim());
          currentChunk = part + ',';
        }
      }
    } else {
      // Try to add sentence to current chunk
      if ((currentChunk + sentence).length <= maxChars) {
        currentChunk += sentence;
      } else {
        if (currentChunk) chunks.push(currentChunk.trim());
        currentChunk = sentence;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Helper function to generate TTS for text chunks
async function generateTTSForChunks(text, voiceId, timestamp, targetDuration = null) {
  const chunks = splitTextIntoChunks(text);
  
  if (chunks.length === 1) {
    console.log('📝 Texto cabe em um único chunk\n');
    return null; // Use normal single TTS
  }
  
  console.log(`📝 Texto dividido em ${chunks.length} chunks para processamento\n`);
  
  const audioChunks = [];
  
  for (let i = 0; i < chunks.length; i++) {
    console.log(`🔊 Gerando áudio para chunk ${i + 1}/${chunks.length}...`);
    console.log(`   Texto do chunk: ${chunks[i].length} caracteres`);
    
    const speechResponse = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voiceId,
      input: chunks[i],
    });
    
    const buffer = Buffer.from(await speechResponse.arrayBuffer());
    const chunkFile = `temp_chunk_${timestamp}_${i}.mp3`;
    fs.writeFileSync(chunkFile, buffer);
    audioChunks.push(chunkFile);
    
    // Check duration of generated chunk
    const { stdout: chunkDurationInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${chunkFile}"`);
    const chunkDuration = parseFloat(chunkDurationInfo.trim());
    
    console.log(`✅ Chunk ${i + 1}/${chunks.length} gerado - ${chunkDuration.toFixed(2)}s de áudio`);
  }
  
  console.log('\n🔗 Concatenando todos os chunks de áudio...');
  
  // Verify all chunks exist and show their durations
  console.log('\n📊 Verificando chunks:');
  let totalChunkDuration = 0;
  for (let i = 0; i < audioChunks.length; i++) {
    const chunkFile = audioChunks[i];
    if (!fs.existsSync(chunkFile)) {
      console.error(`❌ ERRO: Chunk ${i + 1} não encontrado: ${chunkFile}`);
      throw new Error(`Chunk file missing: ${chunkFile}`);
    }
    
    const { stdout: chunkDurInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${chunkFile}"`);
    const chunkDur = parseFloat(chunkDurInfo.trim());
    totalChunkDuration += chunkDur;
    console.log(`   Chunk ${i + 1}: ${chunkDur.toFixed(2)}s ✓`);
  }
  console.log(`   Total esperado: ${totalChunkDuration.toFixed(2)}s\n`);
  
  // Create a file list for ffmpeg concat
  const concatListFile = `temp_concat_${timestamp}.txt`;
  const concatList = audioChunks.map(file => `file '${file}'`).join('\n');
  fs.writeFileSync(concatListFile, concatList);
  
  const finalAudioFile = `dubbed_audio_${timestamp}.mp3`;
  
  // Concatenate all audio chunks
  await execAsync(`ffmpeg -f concat -safe 0 -i "${concatListFile}" -c copy "${finalAudioFile}" -y`);
  
  // Verify final concatenated duration
  const { stdout: finalDurInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioFile}"`);
  const finalDur = parseFloat(finalDurInfo.trim());
  
  console.log('✅ Áudio completo concatenado');
  console.log(`   Duração final: ${finalDur.toFixed(2)}s`);
  
  if (Math.abs(finalDur - totalChunkDuration) > 1) {
    console.log(`   ⚠️  AVISO: Diferença de ${Math.abs(finalDur - totalChunkDuration).toFixed(2)}s entre chunks e arquivo final!`);
  }
  console.log('');
  
  // If target duration is specified, stretch audio to match
  if (targetDuration) {
    const { stdout: currentDurationInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioFile}"`);
    const currentDuration = parseFloat(currentDurationInfo.trim());
    const stretchRatio = targetDuration / currentDuration;
    
    console.log(`\n📊 Análise de duração:`);
    console.log(`   Áudio original: ${targetDuration.toFixed(2)}s`);
    console.log(`   Áudio TTS gerado: ${currentDuration.toFixed(2)}s`);
    console.log(`   Diferença: ${(targetDuration - currentDuration).toFixed(2)}s`);
    console.log(`   Ratio: ${(stretchRatio * 100).toFixed(1)}%\n`);
    
    // Only stretch if we need to slow down (make longer) and difference is significant
    if (stretchRatio > 1.05 && stretchRatio <= 1.7) {
      console.log(`🎚️  Ajustando velocidade do áudio dublado...`);
      const stretchedFile = `dubbed_audio_stretched_${timestamp}.mp3`;
      
      // Use atempo to slow down the audio (inverse of speedup)
      const slowdownFactor = 1 / stretchRatio;
      await execAsync(`ffmpeg -i "${finalAudioFile}" -filter:a "atempo=${slowdownFactor}" "${stretchedFile}" -y`);
      
      // Replace original with stretched
      fs.unlinkSync(finalAudioFile);
      fs.renameSync(stretchedFile, finalAudioFile);
      
      console.log('✅ Duração ajustada\n');
    }
  }
  
  // Cleanup chunk files
  audioChunks.forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  if (fs.existsSync(concatListFile)) fs.unlinkSync(concatListFile);
  
  return finalAudioFile;
}

// Hybrid method: Whisper-1 for timestamps + GPT for refinement
async function transcribeWithHybridMethod(audioFile, language, duration, timestamp) {
  console.log('🔬 Método híbrido: Whisper-1 (timestamps precisos)\n');
  
  const numChunks = Math.ceil(duration / AUDIO_CHUNK_DURATION);
  console.log(`🔪 Dividindo em ${numChunks} chunks de ~${AUDIO_CHUNK_DURATION}s cada\n`);
  
  const allSegments = [];
  const allTranscriptions = [];
  
  for (let i = 0; i < numChunks; i++) {
    const startTime = i * AUDIO_CHUNK_DURATION;
    const chunkFile = `temp_audio_chunk_${timestamp}_${i}.mp3`;
    
    console.log(`🎙️  Processando chunk ${i + 1}/${numChunks}...`);
    
    // Split audio using ffmpeg
    await execAsync(`ffmpeg -i "${audioFile}" -ss ${startTime} -t ${AUDIO_CHUNK_DURATION} -acodec libmp3lame -q:a 2 "${chunkFile}" -y`);
    
    // Step 1: Transcribe with Whisper-1 to get timestamps
    console.log(`📝 Transcrevendo com Whisper-1 (timestamps)...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkFile),
      model: 'whisper-1',
      language: language,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    });
    
    // Step 2: Refine text with GPT - with strict instructions to preserve ALL content
    console.log(`✨ Refinando texto com gpt-5-nano...`);
    
    const charCount = transcription.text.length;
    console.log(`   Texto original: ${charCount} caracteres`);
    
    const refinementResponse = await openai.chat.completions.create({
      model: 'gpt-5-nano-2025-08-07',
      messages: [
        {
          role: 'system',
          content: `You are a transcription editor. Your job is ONLY to fix transcription errors (wrong words, typos), correct grammar, and improve readability. 

CRITICAL RULES:
- You MUST preserve EVERY single piece of information
- Do NOT summarize, condense, or shorten the text
- Do NOT skip any sentences or paragraphs
- The output must be approximately the SAME LENGTH as the input
- Only fix errors, do not rewrite or paraphrase unnecessarily
- Return ONLY the corrected text, no explanations

If the input is ${charCount} characters, your output should be around ${charCount} characters (±10%).`
        },
        {
          role: 'user',
          content: transcription.text
        }
      ]
    });
    
    const refinedText = refinementResponse.choices[0].message.content;
    console.log(`   Texto refinado: ${refinedText.length} caracteres (${((refinedText.length/charCount)*100).toFixed(1)}%)`);
    
    // Warn if text was significantly shortened
    if (refinedText.length < charCount * 0.85) {
      console.log(`   ⚠️  AVISO: Texto foi reduzido em mais de 15%! Usando original.`);
      allTranscriptions.push(transcription.text);
    } else {
      allTranscriptions.push(refinedText);
    }
    
    // Store segments with adjusted timestamps
    if (transcription.segments) {
      transcription.segments.forEach(seg => {
        allSegments.push({
          start: seg.start + startTime,
          end: seg.end + startTime,
          text: seg.text
        });
      });
    }
    
    console.log(`✅ Chunk ${i + 1}/${numChunks} processado\n`);
    
    // Cleanup chunk file
    if (fs.existsSync(chunkFile)) fs.unlinkSync(chunkFile);
  }
  
  console.log('✅ Transcrição híbrida completa\n');
  console.log(`📊 Total de segmentos: ${allSegments.length}\n`);
  
  return {
    text: allTranscriptions.join(' '),
    duration: duration,
    segments: allSegments
  };
}

// Helper function to split audio file into chunks and transcribe
async function transcribeAudioFile(audioFile, language, timestamp, useHybridMethod = false) {
  const fileSize = fs.statSync(audioFile).size;
  
  // Get audio duration first
  const { stdout: durationInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`);
  const duration = parseFloat(durationInfo.trim());
  
  console.log(`📏 Tamanho do arquivo: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`⏱️  Duração real do áudio: ${duration.toFixed(2)}s (${(duration / 60).toFixed(1)} minutos)\n`);
  
  // Force chunking for audio longer than 5 minutes (300s) to avoid incomplete transcriptions
  if (fileSize < MAX_WHISPER_FILE_SIZE && duration < 300) {
    console.log('📝 Arquivo de áudio dentro do limite, transcrevendo...\n');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: 'gpt-4o-mini-transcribe',
      language: language
    });
    
    const fullText = transcription.text;
    
    // Detect silence at the end using ffmpeg
    console.log('🔍 Detectando silêncios no áudio...');
    const { stdout: silenceOutput } = await execAsync(`ffmpeg -i "${audioFile}" -af silencedetect=noise=-30dB:d=0.5 -f null - 2>&1 | grep silence_end`);
    
    let lastSpeechEnd = duration;
    if (silenceOutput) {
      const silenceMatches = silenceOutput.match(/silence_end: ([\d.]+)/g);
      if (silenceMatches && silenceMatches.length > 0) {
        const lastMatch = silenceMatches[silenceMatches.length - 1];
        const lastSilenceEnd = parseFloat(lastMatch.match(/([\d.]+)/)[0]);
        // If last silence ends close to the end, assume speech ends there
        if (duration - lastSilenceEnd < 2) {
          lastSpeechEnd = lastSilenceEnd;
        }
      }
    }
    
    // Create a pseudo-segment for the end
    const pseudoSegments = [{
      start: 0,
      end: lastSpeechEnd,
      text: fullText
    }];
    
    console.log(`✅ Transcrição completa\n`);
    
    return { 
      text: fullText, 
      duration: duration,
      segments: pseudoSegments
    };
  }
  
  console.log('⚠️  Vídeo longo detectado - usando chunking para garantir transcrição completa\n');
  
  if (useHybridMethod) {
    return await transcribeWithHybridMethod(audioFile, language, duration, timestamp);
  }
  
  // File is too large, need to split
  console.log(`⚠️  Arquivo de áudio grande detectado (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log('📝 Dividindo áudio em chunks para transcrição...\n');
  
  const numChunks = Math.ceil(duration / AUDIO_CHUNK_DURATION);
  console.log(`🔪 Dividindo em ${numChunks} chunks de ~${AUDIO_CHUNK_DURATION}s cada\n`);
  
  const transcriptions = [];
  const allSegments = [];
  
  for (let i = 0; i < numChunks; i++) {
    const startTime = i * AUDIO_CHUNK_DURATION;
    const chunkFile = `temp_audio_chunk_${timestamp}_${i}.mp3`;
    
    console.log(`🎙️  Processando chunk ${i + 1}/${numChunks}...`);
    
    // Split audio using ffmpeg
    await execAsync(`ffmpeg -i "${audioFile}" -ss ${startTime} -t ${AUDIO_CHUNK_DURATION} -acodec libmp3lame -q:a 2 "${chunkFile}" -y`);
    
    // Transcribe chunk
    console.log(`📝 Transcrevendo chunk ${i + 1}/${numChunks}...`);
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkFile),
      model: 'gpt-4o-mini-transcribe',
      language: language
    });
    
    transcriptions.push(transcription.text);
    console.log(`✅ Chunk ${i + 1}/${numChunks} transcrito`);
    
    // Cleanup chunk file
    if (fs.existsSync(chunkFile)) fs.unlinkSync(chunkFile);
  }
  
  console.log('\n✅ Todas as transcrições completas, juntando texto...\n');
  
  // Detect silence at the end using ffmpeg on the original file
  console.log('🔍 Detectando silêncios no áudio original...');
  const { stdout: silenceOutput } = await execAsync(`ffmpeg -i "${audioFile}" -af silencedetect=noise=-30dB:d=0.5 -f null - 2>&1 | grep silence_end || echo ""`);
  
  let lastSpeechEnd = duration;
  if (silenceOutput && silenceOutput.trim()) {
    const silenceMatches = silenceOutput.match(/silence_end: ([\d.]+)/g);
    if (silenceMatches && silenceMatches.length > 0) {
      const lastMatch = silenceMatches[silenceMatches.length - 1];
      const lastSilenceEnd = parseFloat(lastMatch.match(/([\d.]+)/)[0]);
      // If last silence ends close to the end, assume speech ends there
      if (duration - lastSilenceEnd < 2) {
        lastSpeechEnd = lastSilenceEnd;
      }
    }
  }
  
  // Create a pseudo-segment for the end
  const pseudoSegments = [{
    start: 0,
    end: lastSpeechEnd,
    text: transcriptions.join(' ')
  }];
  
  return { 
    text: transcriptions.join(' '), 
    duration: duration, 
    segments: pseudoSegments
  };
}

// Language configurations
const LANGUAGES = {
  '1': { code: 'pt', name: 'Português 🇧🇷', systemPrompt: 'Brazilian Portuguese' },
  '2': { code: 'en', name: 'English 🇺🇸', systemPrompt: 'English' },
  '3': { code: 'es', name: 'Español 🇪🇸', systemPrompt: 'Spanish' },
  '4': { code: 'fr', name: 'Français 🇫🇷', systemPrompt: 'French' },
  '5': { code: 'de', name: 'Deutsch 🇩🇪', systemPrompt: 'German' },
  '6': { code: 'it', name: 'Italiano 🇮🇹', systemPrompt: 'Italian' },
  '7': { code: 'ja', name: '日本語 🇯🇵', systemPrompt: 'Japanese' },
  '8': { code: 'ko', name: '한국어 🇰🇷', systemPrompt: 'Korean' },
  '9': { code: 'zh', name: '中文 🇨🇳', systemPrompt: 'Chinese' }
};

// Voice options
const VOICES = {
  '1': { id: 'alloy', name: 'Alloy 🎵 (Neutro e equilibrado)' },
  '2': { id: 'echo', name: 'Echo 🎙️ (Masculino e claro)' },
  '3': { id: 'fable', name: 'Fable ✨ (Expressivo e animado)' },
  '4': { id: 'onyx', name: 'Onyx 🎬 (Masculino profundo)' },
  '5': { id: 'nova', name: 'Nova 🌟 (Feminino jovem)' },
  '6': { id: 'shimmer', name: 'Shimmer 💫 (Feminino suave)' }
};

// Quality options for YouTube download
const QUALITY_OPTIONS = {
  '1': { name: 'Original 🌟 (Melhor qualidade disponível)', format: 'bestvideo+bestaudio/best' },
  '2': { name: '1080p 📺 (Full HD)', format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
  '3': { name: '720p 💻 (HD)', format: 'bestvideo[height<=720]+bestaudio/best[height<=720]' },
  '4': { name: '480p 📱 (SD)', format: 'bestvideo[height<=480]+bestaudio/best[height<=480]' }
};

async function downloadYouTubeVideo(url, formatOption) {
  console.log('\n🚀 Iniciando download do YouTube...\n');

  const args = [
    url,
    '-f', formatOption,
    '--merge-output-format', 'mp4',
    '-N', '10',
    '--progress',
    '--newline',
    '-o', 'downloads/%(title)s.%(ext)s'
  ];

  // Create downloads folder if it doesn't exist
  if (!fs.existsSync('downloads')) {
    fs.mkdirSync('downloads');
  }

  const ytdlp = spawn('yt-dlp', args);

  let outputFile = '';

  ytdlp.stdout.on('data', (data) => {
    const output = data.toString();
    process.stdout.write(output);
    
    // Capture the output filename from multiple patterns
    let match = output.match(/\[Merger\] Merging formats into "(.+?)"/);
    if (match) {
      outputFile = match[1];
    }
    
    // Also check for "already downloaded" message
    match = output.match(/\[download\] (.+?) has already been downloaded/);
    if (match) {
      outputFile = match[1];
    }
    
    // Also check for destination pattern
    match = output.match(/\[download\] Destination: (.+?)$/m);
    if (match) {
      outputFile = match[1];
    }
  });

  ytdlp.stderr.on('data', (data) => {
    const output = data.toString();
    // Only show errors, not info messages
    if (output.includes('ERROR')) {
      process.stderr.write(output);
    }
  });

  return new Promise((resolve, reject) => {
    ytdlp.on('close', (code) => {
      if (code === 0) {
        console.log('\n✅ Download concluído!\n');
        
        // If we couldn't capture the filename, find the most recent .mp4 file
        if (!outputFile) {
          const files = fs.readdirSync('downloads')
            .filter(file => file.endsWith('.mp4'))
            .map(file => ({
              name: file,
              path: `downloads/${file}`,
              time: fs.statSync(`downloads/${file}`).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time); // Sort by most recent first
          
          if (files.length > 0) {
            outputFile = files[0].path;
            console.log(`📁 Arquivo mais recente detectado: ${files[0].name}`);
          }
        }
        
        resolve(outputFile);
      } else {
        reject(new Error(`Download falhou com código ${code}`));
      }
    });
  });
}

async function dubVideo(inputVideo, sourceLang, targetLang, voiceId, askConfirmation = true, useHybridMethod = false) {
  console.log('\n🎬 Iniciando processo de dublagem...\n');
  console.log(`📹 Vídeo de entrada: ${inputVideo}`);
  console.log(`🗣️  ${sourceLang.name} → ${targetLang.name}\n`);

  const timestamp = Date.now();
  const audioFile = `temp_audio_${timestamp}.mp3`;
  const dubbedAudioFile = `dubbed_audio_${timestamp}.mp3`;
  const outputVideo = inputVideo.replace('.mp4', `_${targetLang.code}.mp4`);

  try {
    // Step 1: Extract audio from video
    console.log('📤 Extraindo áudio do vídeo...');
    await execAsync(`ffmpeg -i "${inputVideo}" -vn -acodec libmp3lame -q:a 2 "${audioFile}" -y`);
    console.log('✅ Áudio extraído\n');

    // Step 2: Transcribe audio to text (with chunking for large files)
    console.log(`🎙️  Transcrevendo áudio em ${sourceLang.name}...`);
    const transcriptionResult = await transcribeAudioFile(audioFile, sourceLang.code, timestamp, useHybridMethod);
    const transcriptionText = transcriptionResult.text;
    const originalAudioDuration = transcriptionResult.duration;
    const segments = transcriptionResult.segments;
    
    console.log('✅ Transcrição completa:', transcriptionText.substring(0, 150) + '...\n');
    console.log(`⏱️  Duração do áudio original: ${originalAudioDuration.toFixed(2)}s`);
    
    if (segments && segments.length > 0) {
      const lastSegmentEnd = segments[segments.length - 1].end;
      const silenceAtEnd = originalAudioDuration - lastSegmentEnd;
      console.log(`🔊 Última fala termina em: ${lastSegmentEnd.toFixed(2)}s`);
      console.log(`🔇 Silêncio no final: ${silenceAtEnd.toFixed(2)}s\n`);
    } else {
      console.log('');
    }

    // Step 3: Translate text
    console.log(`🌐 Traduzindo para ${targetLang.name}...`);
    const translationResponse = await openai.chat.completions.create({
      model: 'o4-mini',
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the following text from ${sourceLang.systemPrompt} to ${targetLang.systemPrompt}. Keep the same tone, style, and natural flow. Only return the translated text, nothing else.`
        },
        {
          role: 'user',
          content: transcriptionText
        }
      ]
    });
    const translatedText = translationResponse.choices[0].message.content;
    console.log('✅ Tradução:', translatedText.substring(0, 150) + '...\n');
    
    // Save transcription and translation for debugging
    const debugFolder = 'debug_logs';
    if (!fs.existsSync(debugFolder)) {
      fs.mkdirSync(debugFolder);
    }
    
    fs.writeFileSync(`${debugFolder}/transcription_${timestamp}.txt`, transcriptionText);
    fs.writeFileSync(`${debugFolder}/translation_${timestamp}.txt`, translatedText);
    
    const transcriptionWords = transcriptionText.split(/\s+/).length;
    const translationWords = translatedText.split(/\s+/).length;
    
    console.log(`📊 Estatísticas:`);
    console.log(`   Original: ${transcriptionText.length} caracteres, ${transcriptionWords} palavras`);
    console.log(`   Tradução: ${translatedText.length} caracteres, ${translationWords} palavras`);
    console.log(`   Ratio: ${(translationWords / transcriptionWords * 100).toFixed(1)}%\n`);

    // Ask if user wants to continue with this translation (only if askConfirmation is true)
    if (askConfirmation) {
      const continueChoice = await question('📋 Deseja continuar com esta tradução? (s/n): ');
      if (continueChoice.toLowerCase() !== 's') {
        console.log('⏸️  Processo cancelado pelo usuário.');
        cleanup();
        return null;
      }
    } else {
      console.log('▶️  Continuando automaticamente...\n');
    }

    // Step 4: Generate speech using TTS (with chunking for long texts)
    console.log(`🔊 Gerando áudio dublado com voz ${voiceId}...`);
    
    // Calculate target duration (exclude trailing silence if we have segments)
    let targetDuration = originalAudioDuration;
    if (segments && segments.length > 0) {
      const lastSegmentEnd = segments[segments.length - 1].end;
      targetDuration = lastSegmentEnd; // Only match duration up to last speech
      console.log(`🎯 Ajustando para duração da fala: ${targetDuration.toFixed(2)}s (excluindo silêncio final)\n`);
    }
    
    let finalAudioPath;
    if (translatedText.length > MAX_TTS_CHARS) {
      console.log(`⚠️  Texto longo detectado (${translatedText.length} caracteres)\n`);
      finalAudioPath = await generateTTSForChunks(translatedText, voiceId, timestamp, targetDuration);
      
      if (!finalAudioPath) {
        // Fallback to single TTS if chunking returned null
        const speechResponse = await openai.audio.speech.create({
          model: 'gpt-4o-mini-tts',
          voice: voiceId,
          input: translatedText,
        });
        const buffer = Buffer.from(await speechResponse.arrayBuffer());
        fs.writeFileSync(dubbedAudioFile, buffer);
        finalAudioPath = dubbedAudioFile;
      }
    } else {
      // Normal single TTS for short texts
      console.log('📝 Gerando áudio em uma única requisição\n');
      const speechResponse = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: voiceId,
        input: translatedText,
      });
      const buffer = Buffer.from(await speechResponse.arrayBuffer());
      fs.writeFileSync(dubbedAudioFile, buffer);
      finalAudioPath = dubbedAudioFile;
    }
    
    // Check final audio duration and pad with silence to match video
    const { stdout: currentDurationInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`);
    const currentAudioDuration = parseFloat(currentDurationInfo.trim());
    
    console.log(`\n📏 Duração atual do áudio: ${currentAudioDuration.toFixed(2)}s`);
    console.log(`📏 Duração do vídeo: ${originalAudioDuration.toFixed(2)}s`);
    
    const silenceNeeded = originalAudioDuration - currentAudioDuration;
    
    if (silenceNeeded > 0.5) {
      console.log(`🔇 Adicionando ${silenceNeeded.toFixed(2)}s de silêncio para igualar duração do vídeo...`);
      const finalWithSilence = `dubbed_audio_with_silence_${timestamp}.mp3`;
      await execAsync(`ffmpeg -i "${finalAudioPath}" -f lavfi -t ${silenceNeeded} -i anullsrc=r=44100:cl=stereo -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1" "${finalWithSilence}" -y`);
      
      if (finalAudioPath !== dubbedAudioFile) {
        fs.unlinkSync(finalAudioPath);
      }
      finalAudioPath = finalWithSilence;
      console.log('✅ Silêncio adicionado\n');
    } else {
      console.log(`✅ Duração já está correta\n`);
    }
    
    console.log('✅ Áudio dublado gerado\n');

    // Step 5: Check duration and adjust if needed
    console.log('⏱️  Verificando duração do vídeo/áudio...');
    const { stdout: videoInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputVideo}"`);
    const videoDuration = parseFloat(videoInfo.trim());

    const { stdout: audioInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`);
    const audioDuration = parseFloat(audioInfo.trim());

    console.log(`📹 Vídeo: ${videoDuration.toFixed(2)}s`);
    console.log(`🎵 Áudio: ${audioDuration.toFixed(2)}s\n`);

    // Step 6: Replace audio in video
    console.log('🎥 Substituindo áudio no vídeo...');

    let audioFilter = '';
    const speedRatio = videoDuration / audioDuration;

    // atempo only supports 0.5 to 2.0, for larger changes we need to chain multiple atempo filters
    if (Math.abs(speedRatio - 1) > 0.05) {
      if (speedRatio >= 0.5 && speedRatio <= 2.0) {
        console.log(`⚙️  Ajustando velocidade do áudio em ${(speedRatio * 100).toFixed(1)}%...`);
        audioFilter = `-filter:a "atempo=${speedRatio}"`;
      } else if (speedRatio > 2.0) {
        // Chain multiple atempo for speed > 2x
        console.log(`⚙️  Ajustando velocidade do áudio em ${(speedRatio * 100).toFixed(1)}% (cadeia múltipla)...`);
        const iterations = Math.ceil(Math.log2(speedRatio));
        let filters = [];
        let remaining = speedRatio;
        for (let i = 0; i < iterations; i++) {
          const step = Math.min(remaining, 2.0);
          filters.push(`atempo=${step}`);
          remaining /= step;
        }
        audioFilter = `-filter:a "${filters.join(',')}"`;
      } else {
        // For very slow speeds, also chain
        console.log(`⚙️  Ajustando velocidade do áudio em ${(speedRatio * 100).toFixed(1)}% (cadeia múltipla)...`);
        const iterations = Math.ceil(Math.log2(1/speedRatio));
        let filters = [];
        let remaining = speedRatio;
        for (let i = 0; i < iterations; i++) {
          const step = Math.max(remaining, 0.5);
          filters.push(`atempo=${step}`);
          remaining /= step;
        }
        audioFilter = `-filter:a "${filters.join(',')}"`;
      }
    }

    await execAsync(`ffmpeg -i "${inputVideo}" -i "${finalAudioPath}" -c:v copy ${audioFilter} -map 0:v:0 -map 1:a:0 "${outputVideo}" -y`);
    console.log('✅ Vídeo dublado criado!\n');

    // Cleanup
    console.log('🧹 Limpando arquivos temporários...');
    cleanup();
    console.log('✅ Limpeza concluída\n');

    console.log(`🎉 PRONTO! Seu vídeo dublado está aqui: ${outputVideo}`);
    return outputVideo;

  } catch (error) {
    console.error('\n❌ Erro durante a dublagem:', error.message);
    cleanup();
    throw error;
  }

  function cleanup() {
    try {
      if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
      if (fs.existsSync(dubbedAudioFile)) fs.unlinkSync(dubbedAudioFile);
    } catch (e) {
      console.error('⚠️  Aviso: Não foi possível limpar todos os arquivos temporários');
    }
  }
}

async function selectLanguage(prompt) {
  console.log(prompt);
  Object.entries(LANGUAGES).forEach(([key, { name }]) => {
    console.log(`  ${key}. ${name}`);
  });

  const choice = await question('\n🔢 Digite o número da opção: ');
  const selected = LANGUAGES[choice];

  if (!selected) {
    console.log('❌ Opção inválida!');
    return null;
  }

  console.log(`✨ Selecionado: ${selected.name}\n`);
  return selected;
}

async function selectVoice() {
  console.log('\n🎤 Escolha a voz para dublagem:\n');
  Object.entries(VOICES).forEach(([key, { name }]) => {
    console.log(`  ${key}. ${name}`);
  });

  const choice = await question('\n🔢 Digite o número da opção: ');
  const selected = VOICES[choice];

  if (!selected) {
    console.log('❌ Opção inválida!');
    return null;
  }

  console.log(`✨ Voz selecionada: ${selected.name}\n`);
  return selected.id;
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
  console.log('║   🎬 AI VIDEO DUBBING STUDIO 🎙️       ║');
  console.log('║   Baixe e Duble Vídeos com IA! ✨     ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log('🎯 O que você deseja fazer?\n');
  console.log('  1. 🌐 Baixar vídeo do YouTube e dublar');
  console.log('  2. 📁 Dublar um vídeo local existente');
  console.log('  3. 🚪 Sair\n');

  const mainChoice = await question('🔢 Digite o número da opção: ');

  let videoFile = '';

  if (mainChoice === '1') {
    // Download from YouTube
    console.log('\n🌐 === DOWNLOAD DO YOUTUBE ===\n');
    
    const url = await question('📎 Cole a URL do vídeo do YouTube: ');
    
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      console.log('❌ URL inválida! Use uma URL do YouTube.');
      rl.close();
      return;
    }

    const quality = await selectQuality();
    if (!quality) {
      rl.close();
      return;
    }

    try {
      videoFile = await downloadYouTubeVideo(url, quality);
      console.log(`📹 Vídeo baixado: ${videoFile}\n`);
    } catch (error) {
      console.error('❌ Erro no download:', error.message);
      rl.close();
      return;
    }

  } else if (mainChoice === '2') {
    // Use existing video
    console.log('\n📁 === VÍDEO LOCAL ===\n');
    videoFile = await question('📂 Cole o caminho do arquivo de vídeo (ou arraste aqui): ');
    videoFile = videoFile.replace(/['"]/g, '').trim();

    if (!fs.existsSync(videoFile)) {
      console.log('❌ Arquivo não encontrado!');
      rl.close();
      return;
    }

  } else if (mainChoice === '3') {
    console.log('\n👋 Até logo!\n');
    rl.close();
    return;
  } else {
    console.log('❌ Opção inválida!');
    rl.close();
    return;
  }

  // Dubbing process
  console.log('\n🎙️  === CONFIGURAÇÃO DA DUBLAGEM ===\n');

  const sourceLang = await selectLanguage('🗣️  Idioma ORIGINAL do vídeo:\n');
  if (!sourceLang) {
    rl.close();
    return;
  }

  const targetLang = await selectLanguage('🎯 Idioma ALVO (para qual deseja dublar):\n');
  if (!targetLang) {
    rl.close();
    return;
  }

  const voiceId = await selectVoice();
  if (!voiceId) {
    rl.close();
    return;
  }

  // Select transcription method
  console.log('\n🔬 Método de transcrição:\n');
  console.log('  1. Rápido e Econômico (gpt-4o-mini + detecção de silêncio)');
  console.log('  2. Preciso com Timestamps (whisper-1 com timestamps exatos)\n');
  
  const transcriptionChoice = await question('🔢 Escolha o método (Enter=Rápido): ');
  const useHybridMethod = transcriptionChoice === '2';
  
  if (useHybridMethod) {
    console.log('✨ Usando método com timestamps: Whisper-1\n');
  } else {
    console.log('⚡ Usando método rápido: gpt-4o-mini + ffmpeg\n');
  }

  const confirmChoice = await question('💡 Deseja revisar a tradução antes de gerar o áudio? (s/n): ');
  const askConfirmation = confirmChoice.toLowerCase() === 's';

  rl.close();

  // Start dubbing
  try {
    await dubVideo(videoFile, sourceLang, targetLang, voiceId, askConfirmation, useHybridMethod);
    console.log('\n🌟 Processo concluído com sucesso! 🌟\n');
  } catch (error) {
    console.error('\n❌ Erro:', error.message);
    process.exit(1);
  }
}

main();
