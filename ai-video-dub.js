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
    if (stretchRatio > 1.05 && stretchRatio <= 2.0) {
      console.log(`🎚️  Ajustando velocidade do áudio dublado (desacelerando para ${(stretchRatio * 100).toFixed(1)}%)...`);
      const stretchedFile = `dubbed_audio_stretched_${timestamp}.mp3`;
      
      // atempo filter: values < 1.0 SLOW DOWN (desacelera), values > 1.0 SPEED UP (acelera)
      // We need to SLOW DOWN to make audio longer, so use INVERSE of stretchRatio
      // Example: if audio is 600s and needs to be 1000s, stretchRatio=1.67
      //          we need atempo=0.6 (1/1.67) to slow it down 40% and make it 67% longer
      const slowdownFactor = 1 / stretchRatio;
      
      // atempo only accepts 0.5-2.0, so we might need to chain filters
      let atempoCommand;
      if (slowdownFactor >= 0.5) {
        // Single filter is enough
        atempoCommand = `atempo=${slowdownFactor.toFixed(6)}`;
      } else {
        // Need to chain multiple filters (slowdownFactor < 0.5)
        // Example: slowdownFactor=0.25 → atempo=0.5,atempo=0.5
        atempoCommand = `atempo=0.5,atempo=${(slowdownFactor / 0.5).toFixed(6)}`;
      }
      
      console.log(`   Aplicando atempo=${slowdownFactor.toFixed(3)} (${atempoCommand})`);
      await execAsync(`ffmpeg -i "${finalAudioFile}" -filter:a "${atempoCommand}" "${stretchedFile}" -y`);
      
      // Replace original with stretched
      fs.unlinkSync(finalAudioFile);
      fs.renameSync(stretchedFile, finalAudioFile);
      
      console.log('✅ Duração ajustada\n');
    } else if (stretchRatio > 2.0) {
      console.log(`⚠️  AVISO: Ratio muito alto (${(stretchRatio * 100).toFixed(1)}%) - tradução pode estar incompleta!`);
      console.log(`   Desacelerando no máximo possível (4x via atempo=0.5,atempo=0.5)...\n`);
      const stretchedFile = `dubbed_audio_stretched_${timestamp}.mp3`;
      // Chain two atempo=0.5 for 4x slowdown (maximum practical)
      await execAsync(`ffmpeg -i "${finalAudioFile}" -filter:a "atempo=0.5,atempo=0.5" "${stretchedFile}" -y`);
      fs.unlinkSync(finalAudioFile);
      fs.renameSync(stretchedFile, finalAudioFile);
      console.log('✅ Áudio desacelerado (pode ainda ficar dessincronizado)\n');
    }
  }
  
  // Cleanup chunk files
  audioChunks.forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  if (fs.existsSync(concatListFile)) fs.unlinkSync(concatListFile);
  
  return finalAudioFile;
}

// Generate TTS with preserved silence gaps
async function generateTTSWithGaps(translatedText, voiceId, timestamp, segments, silenceGaps, totalDuration, silenceAtStart, silenceAtEnd, inputVideo, audioFile, targetLang) {
  console.log('🎯 Dividindo texto em blocos correspondentes às pausas...\n');
  
  // Create speech blocks based on silence gaps
  const speechBlocks = [];
  
  if (segments.length === 0) {
    // No segments - shouldn't happen but handle it
    speechBlocks.push({
      start: silenceAtStart,
      end: totalDuration - silenceAtEnd,
      duration: totalDuration - silenceAtStart - silenceAtEnd,
      text: translatedText
    });
  } else {
    // Create blocks from segments, grouping segments between gaps
    let currentBlockSegments = [];
    let blockStart = segments[0].start;
    
    segments.forEach((seg, i) => {
      currentBlockSegments.push(seg);
      
      // Check if there's a gap after this segment
      const gapAfter = silenceGaps.find(g => g.afterSegment === i);
      
      if (gapAfter || i === segments.length - 1) {
        // End of block
        const blockEnd = seg.end;
        const blockDuration = blockEnd - blockStart;
        
        speechBlocks.push({
          start: blockStart,
          end: blockEnd,
          duration: blockDuration,
          text: '', // Will be filled with TRANSLATED text below
          segmentCount: currentBlockSegments.length
        });
        
        // Start new block after gap
        if (i < segments.length - 1) {
          blockStart = segments[i + 1].start;
          currentBlockSegments = [];
        }
      }
    });
    
    // ALWAYS distribute TRANSLATED text proportionally to blocks
    // NOTE: Segments contain ORIGINAL language text, but we need TRANSLATED text for TTS
    const totalSpeechDuration = speechBlocks.reduce((sum, b) => sum + b.duration, 0);
    
    console.log('📝 Distribuindo texto traduzido proporcionalmente aos blocos...\n');
    
    const words = translatedText.split(/\s+/);
    let wordIndex = 0;
    
    speechBlocks.forEach((block, i) => {
      const proportion = block.duration / totalSpeechDuration;
      const wordsForBlock = Math.round(words.length * proportion);
      const blockWords = words.slice(wordIndex, wordIndex + wordsForBlock);
      block.text = blockWords.join(' ');
      wordIndex += wordsForBlock;
      
      console.log(`   Bloco ${i + 1}: ${block.duration.toFixed(1)}s (${(proportion * 100).toFixed(1)}%) → ${blockWords.length} palavras`);
    });
    
    // Add any remaining words to last block
    if (wordIndex < words.length) {
      const remaining = words.slice(wordIndex).join(' ');
      speechBlocks[speechBlocks.length - 1].text += ' ' + remaining;
      console.log(`   ⚠️  ${words.length - wordIndex} palavras restantes adicionadas ao último bloco`);
    }
    console.log('');
  }
  
  console.log(`📊 Total de ${speechBlocks.length} blocos de fala:\n`);
  speechBlocks.forEach((block, i) => {
    const mins = Math.floor(block.start / 60);
    const secs = (block.start % 60).toFixed(1);
    console.log(`   ${i + 1}. ${mins}:${secs.padStart(4, '0')} → ${block.duration.toFixed(2)}s (${block.text.length} chars)`);
  });
  console.log('');
  
  // Generate TTS for each block
  const audioFiles = [];
  
  for (let i = 0; i < speechBlocks.length; i++) {
    const block = speechBlocks[i];
    console.log(`🔊 Gerando áudio para bloco ${i + 1}/${speechBlocks.length}...`);
    console.log(`   Duração alvo: ${block.duration.toFixed(2)}s`);
    console.log(`   Texto: ${block.text.substring(0, 100)}...`);
    
    const blockAudioFile = `speech_block_${timestamp}_${i}.mp3`;
    
    // Generate TTS for this block
    const speechResponse = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voiceId,
      input: block.text
    });
    
    const buffer = Buffer.from(await speechResponse.arrayBuffer());
    fs.writeFileSync(blockAudioFile, buffer);
    
    // Check duration and adjust if needed
    const { stdout: blockDurInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${blockAudioFile}"`);
    const blockAudioDuration = parseFloat(blockDurInfo.trim());
    
    console.log(`   Gerado: ${blockAudioDuration.toFixed(2)}s`);
    
    // Adjust speed if needed
    if (Math.abs(blockAudioDuration - block.duration) > 1.0) {
      const ratio = block.duration / blockAudioDuration;
      console.log(`   Ajustando velocidade (ratio: ${(ratio * 100).toFixed(1)}%)...`);
      
      const slowdownFactor = 1 / ratio;
      const adjustedFile = `speech_block_${timestamp}_${i}_adjusted.mp3`;
      
      if (slowdownFactor >= 0.5 && slowdownFactor <= 2.0) {
        await execAsync(`ffmpeg -i "${blockAudioFile}" -filter:a "atempo=${slowdownFactor.toFixed(6)}" "${adjustedFile}" -y`);
        fs.unlinkSync(blockAudioFile);
        audioFiles.push(adjustedFile);
        console.log(`   ✅ Ajustado para ${block.duration.toFixed(2)}s`);
      } else {
        console.log(`   ⚠️  Ratio fora do limite, usando sem ajuste`);
        audioFiles.push(blockAudioFile);
      }
    } else {
      audioFiles.push(blockAudioFile);
      console.log(`   ✅ Duração OK`);
    }
    console.log('');
  }
  
  // Now concatenate with silences
  console.log('🔗 Concatenando blocos com pausas...\n');
  
  const concatParts = [];
  
  // Add initial silence
  if (silenceAtStart > 0.1) {
    const startSilenceFile = `silence_start_${timestamp}.mp3`;
    await execAsync(`ffmpeg -f lavfi -t ${silenceAtStart} -i anullsrc=r=44100:cl=stereo "${startSilenceFile}" -y`);
    concatParts.push(`file '${startSilenceFile}'`);
    console.log(`   🔇 Silêncio inicial: ${silenceAtStart.toFixed(2)}s`);
  }
  
  // Add speech blocks with gaps between them
  for (let i = 0; i < audioFiles.length; i++) {
    concatParts.push(`file '${audioFiles[i]}'`);
    console.log(`   🗣️  Bloco ${i + 1}: ${speechBlocks[i].duration.toFixed(2)}s`);
    
    // Add gap if not last block
    if (i < audioFiles.length - 1) {
      const gap = silenceGaps[i];
      if (gap) {
        const gapFile = `silence_gap_${timestamp}_${i}.mp3`;
        await execAsync(`ffmpeg -f lavfi -t ${gap.duration} -i anullsrc=r=44100:cl=stereo "${gapFile}" -y`);
        concatParts.push(`file '${gapFile}'`);
        console.log(`   🔇 Pausa: ${gap.duration.toFixed(2)}s`);
      }
    }
  }
  
  // Add final silence
  if (silenceAtEnd > 0.1) {
    const endSilenceFile = `silence_end_${timestamp}.mp3`;
    await execAsync(`ffmpeg -f lavfi -t ${silenceAtEnd} -i anullsrc=r=44100:cl=stereo "${endSilenceFile}" -y`);
    concatParts.push(`file '${endSilenceFile}'`);
    console.log(`   🔇 Silêncio final: ${silenceAtEnd.toFixed(2)}s`);
  }
  
  // Concatenate all parts
  const concatListFile = `concat_with_gaps_${timestamp}.txt`;
  fs.writeFileSync(concatListFile, concatParts.join('\n'));
  
  const finalAudioFile = `dubbed_audio_with_gaps_${timestamp}.mp3`;
  await execAsync(`ffmpeg -f concat -safe 0 -i "${concatListFile}" -c copy "${finalAudioFile}" -y`);
  
  console.log(`\n✅ Áudio final gerado com pausas preservadas!`);
  
  // Verify duration
  const { stdout: finalDurInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioFile}"`);
  const finalDuration = parseFloat(finalDurInfo.trim());
  
  console.log(`   Duração final: ${finalDuration.toFixed(2)}s`);
  console.log(`   Duração esperada: ${totalDuration.toFixed(2)}s`);
  console.log(`   Diferença: ${Math.abs(finalDuration - totalDuration).toFixed(2)}s\n`);
  
  // Cleanup temp files
  audioFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
  if (fs.existsSync(concatListFile)) fs.unlinkSync(concatListFile);
  
  // Continue with video merging (copied from original flow)
  console.log('✅ Áudio dublado gerado\n');
  
  console.log('⏱️  Verificando duração do vídeo/áudio...');
  const { stdout: videoInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputVideo}"`);
  const videoDuration = parseFloat(videoInfo.trim());
  
  console.log(`📹 Vídeo: ${videoDuration.toFixed(2)}s`);
  console.log(`🎵 Áudio: ${finalDuration.toFixed(2)}s\n`);
  
  const dubbedAudioFile = `dubbed_audio_${timestamp}.mp3`;
  const outputVideo = inputVideo.replace('.mp4', `_${targetLang.code}.mp4`);
  
  console.log('🎥 Substituindo áudio no vídeo...');
  await execAsync(`ffmpeg -i "${inputVideo}" -i "${finalAudioFile}" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest "${outputVideo}" -y`);
  console.log('✅ Vídeo dublado criado!\n');
  
  console.log('🧹 Limpando arquivos temporários...');
  if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
  if (fs.existsSync(finalAudioFile)) fs.unlinkSync(finalAudioFile);
  if (fs.existsSync(dubbedAudioFile)) fs.unlinkSync(dubbedAudioFile);
  
  // Clean up any remaining temp files
  const tempFiles = fs.readdirSync('.').filter(f => 
    f.includes(`_${timestamp}`) && 
    (f.endsWith('.mp3') || f.endsWith('.txt'))
  );
  tempFiles.forEach(f => {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
  
  console.log('✅ Limpeza concluída\n');
  
  console.log(`🎉 PRONTO! Seu vídeo dublado está aqui: ${outputVideo}\n`);
  
  return outputVideo;
}

// Helper function to detect silence gaps between speech segments
function detectSilenceGaps(segments, minGapDuration = 2.0) {
  const gaps = [];
  
  for (let i = 0; i < segments.length - 1; i++) {
    const currentEnd = segments[i].end;
    const nextStart = segments[i + 1].start;
    const gapDuration = nextStart - currentEnd;
    
    if (gapDuration >= minGapDuration) {
      gaps.push({
        start: currentEnd,
        end: nextStart,
        duration: gapDuration,
        afterSegment: i,
        beforeSegment: i + 1
      });
    }
  }
  
  return gaps;
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
    
    // Use transcription directly - GPT refinement is causing content loss
    // The Whisper-1 transcription is already very accurate
    console.log(`✅ Usando transcrição direta (sem refinamento para evitar perda de conteúdo)`);
    allTranscriptions.push(transcription.text);
    
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
  
  // Detect silence gaps between segments
  const silenceGaps = detectSilenceGaps(allSegments, 2.0);
  
  if (silenceGaps.length > 0) {
    console.log(`🔇 Pausas/silêncios detectados no meio: ${silenceGaps.length}`);
    silenceGaps.forEach((gap, i) => {
      const mins = Math.floor(gap.start / 60);
      const secs = (gap.start % 60).toFixed(1);
      console.log(`   ${i + 1}. ${mins}:${secs.padStart(4, '0')} → ${gap.duration.toFixed(2)}s`);
    });
    console.log('');
  }
  
  return {
    text: allTranscriptions.join(' '),
    duration: duration,
    segments: allSegments,
    silenceGaps: silenceGaps
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
    
    // Detect ALL silences using ffmpeg
    console.log('🔍 Detectando silêncios no áudio...');
    const { stdout: silenceOutput } = await execAsync(`ffmpeg -i "${audioFile}" -af silencedetect=noise=-30dB:d=2.0 -f null - 2>&1 | grep "silence_"`);
    
    // Parse silence detection output
    const silences = [];
    const lines = silenceOutput.split('\n');
    let currentSilence = {};
    
    for (const line of lines) {
      const startMatch = line.match(/silence_start: ([\d.]+)/);
      const endMatch = line.match(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/);
      
      if (startMatch) {
        currentSilence.start = parseFloat(startMatch[1]);
      }
      
      if (endMatch && currentSilence.start !== undefined) {
        currentSilence.end = parseFloat(endMatch[1]);
        currentSilence.duration = parseFloat(endMatch[2]);
        silences.push({ ...currentSilence });
        currentSilence = {};
      }
    }
    
    console.log(`   Silêncios detectados: ${silences.length}`);
    
    // Create segments based on silences
    const pseudoSegments = [];
    let lastEnd = 0;
    
    silences.forEach((silence, i) => {
      // Speech segment before silence
      if (silence.start > lastEnd) {
        pseudoSegments.push({
          start: lastEnd,
          end: silence.start,
          text: '' // Text will be distributed later
        });
      }
      lastEnd = silence.end;
    });
    
    // Final speech segment
    if (lastEnd < duration) {
      pseudoSegments.push({
        start: lastEnd,
        end: duration,
        text: ''
      });
    }
    
    // If no segments created, create one for entire duration
    if (pseudoSegments.length === 0) {
      pseudoSegments.push({
        start: 0,
        end: duration,
        text: fullText
      });
    } else {
      // Put all text in first segment for now
      pseudoSegments[0].text = fullText;
    }
    
    const silenceGaps = silences.map((s, i) => ({
      start: s.start,
      end: s.end,
      duration: s.duration,
      afterSegment: i,
      beforeSegment: i + 1
    }));
    
    if (silenceGaps.length > 0) {
      console.log(`🔇 Pausas/silêncios detectados no meio: ${silenceGaps.length}`);
      silenceGaps.forEach((gap, i) => {
        const mins = Math.floor(gap.start / 60);
        const secs = (gap.start % 60).toFixed(1);
        console.log(`   ${i + 1}. ${mins}:${secs.padStart(4, '0')} → ${gap.duration.toFixed(2)}s`);
      });
    }
    
    console.log(`✅ Transcrição completa\n`);
    
    return { 
      text: fullText, 
      duration: duration,
      segments: pseudoSegments,
      silenceGaps: silenceGaps
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
    
    const wordCount = transcriptionText.split(/\s+/).length;
    
    const translationResponse = await openai.chat.completions.create({
      model: 'o4-mini',
      messages: [
        {
          role: 'system',
          content: `You are a professional translator for video dubbing. Translate the following text from ${sourceLang.systemPrompt} to ${targetLang.systemPrompt}.

CRITICAL RULES FOR VIDEO DUBBING:
- Translate EVERY single sentence and piece of information
- Do NOT summarize, shorten, or skip ANY content
- Maintain the same level of detail and description
- Keep the same tone, style, and natural flow
- The output should have approximately the SAME NUMBER OF WORDS (±15%)
- This is for lip-sync dubbing, so completeness is critical

Input has ${wordCount} words. Your translation should have around ${wordCount} words (${Math.floor(wordCount * 0.85)}-${Math.ceil(wordCount * 1.15)} words acceptable).

Return ONLY the translated text, no explanations or notes.`
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
    
    // Save segments with timestamps as JSON
    if (segments && segments.length > 0) {
      const segmentsData = {
        duration: originalAudioDuration,
        segmentCount: segments.length,
        segments: segments.map(s => ({
          start: s.start,
          end: s.end,
          duration: s.end - s.start,
          text: s.text || ''
        })),
        silenceGaps: transcriptionResult.silenceGaps || []
      };
      fs.writeFileSync(`${debugFolder}/segments_${timestamp}.json`, JSON.stringify(segmentsData, null, 2));
      console.log(`💾 Timestamps salvos em: ${debugFolder}/segments_${timestamp}.json\n`);
    }
    
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
    
    // Get silence gaps from transcription result
    const silenceGaps = transcriptionResult.silenceGaps || [];
    
    // Calculate speech boundaries (where actual speech starts and ends)
    let speechStart = 0;
    let speechEnd = originalAudioDuration;
    let silenceAtStart = 0;
    let silenceAtEnd = 0;
    
    if (segments && segments.length > 0) {
      speechStart = segments[0].start;
      speechEnd = segments[segments.length - 1].end;
      silenceAtStart = speechStart;
      silenceAtEnd = originalAudioDuration - speechEnd;
      
      console.log(`\n📊 Análise de silêncio:`);
      console.log(`   Silêncio no início: ${silenceAtStart.toFixed(2)}s`);
      console.log(`   Fala: ${speechStart.toFixed(2)}s → ${speechEnd.toFixed(2)}s (duração: ${(speechEnd - speechStart).toFixed(2)}s)`);
      console.log(`   Silêncio no final: ${silenceAtEnd.toFixed(2)}s`);
      console.log(`   Duração total do vídeo: ${originalAudioDuration.toFixed(2)}s`);
      
      if (silenceGaps.length > 0) {
        console.log(`   Pausas no meio: ${silenceGaps.length}`);
        silenceGaps.forEach((gap, i) => {
          const mins = Math.floor(gap.start / 60);
          const secs = (gap.start % 60).toFixed(1);
          console.log(`      ${i + 1}. ${mins}:${secs.padStart(4, '0')} → ${gap.duration.toFixed(2)}s`);
        });
      }
      console.log('');
    }
    
    // If there are silence gaps in the middle, we need to generate TTS per speech block
    if (silenceGaps.length > 0) {
      console.log(`🎯 Modo avançado: Gerando áudio com pausas preservadas\n`);
      return await generateTTSWithGaps(translatedText, voiceId, timestamp, segments, silenceGaps, originalAudioDuration, silenceAtStart, silenceAtEnd, inputVideo, audioFile, targetLang);
    }
    
    // Original flow: single speech block or no gaps detected
    // Target duration is only for the speech part (excluding leading/trailing silence)
    const targetDuration = speechEnd - speechStart;
    
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
    
    // Add silence at start and end to match original video exactly
    console.log(`\n🔇 Adicionando silêncios do vídeo original...`);
    
    const { stdout: currentDurationInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${finalAudioPath}"`);
    const currentAudioDuration = parseFloat(currentDurationInfo.trim());
    
    console.log(`   Áudio TTS gerado: ${currentAudioDuration.toFixed(2)}s`);
    console.log(`   Adicionando ${silenceAtStart.toFixed(2)}s no início`);
    console.log(`   Adicionando ${silenceAtEnd.toFixed(2)}s no final`);
    
    const finalWithSilence = `dubbed_audio_with_silence_${timestamp}.mp3`;
    
    if (silenceAtStart > 0.1 || silenceAtEnd > 0.1) {
      // Generate silence files
      const startSilenceFile = `silence_start_${timestamp}.mp3`;
      const endSilenceFile = `silence_end_${timestamp}.mp3`;
      
      // Create concat list with start silence, audio, and end silence
      const concatParts = [];
      
      if (silenceAtStart > 0.1) {
        await execAsync(`ffmpeg -f lavfi -t ${silenceAtStart} -i anullsrc=r=44100:cl=stereo "${startSilenceFile}" -y`);
        concatParts.push(`file '${startSilenceFile}'`);
      }
      
      concatParts.push(`file '${finalAudioPath}'`);
      
      if (silenceAtEnd > 0.1) {
        await execAsync(`ffmpeg -f lavfi -t ${silenceAtEnd} -i anullsrc=r=44100:cl=stereo "${endSilenceFile}" -y`);
        concatParts.push(`file '${endSilenceFile}'`);
      }
      
      // Concatenate all parts
      const concatListFile = `concat_silence_${timestamp}.txt`;
      fs.writeFileSync(concatListFile, concatParts.join('\n'));
      
      await execAsync(`ffmpeg -f concat -safe 0 -i "${concatListFile}" -c copy "${finalWithSilence}" -y`);
      
      // Cleanup
      if (fs.existsSync(startSilenceFile)) fs.unlinkSync(startSilenceFile);
      if (fs.existsSync(endSilenceFile)) fs.unlinkSync(endSilenceFile);
      if (fs.existsSync(concatListFile)) fs.unlinkSync(concatListFile);
      
      if (finalAudioPath !== dubbedAudioFile) {
        fs.unlinkSync(finalAudioPath);
      }
      finalAudioPath = finalWithSilence;
      
      console.log('✅ Silêncios adicionados\n');
    } else {
      console.log('✅ Sem silêncios significativos para adicionar\n');
      // Rename to match expected filename
      fs.renameSync(finalAudioPath, finalWithSilence);
      finalAudioPath = finalWithSilence;
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
