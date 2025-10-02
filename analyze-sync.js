#!/usr/bin/env node

/**
 * Script de Análise de Sincronização de Vídeo
 * Compara vídeo original com vídeo dublado e detecta dessincronizações
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

// Configuração
const SILENCE_THRESHOLD = '-30dB';  // Nível de ruído para considerar silêncio
const MIN_SILENCE_DURATION = 2.0;   // Duração mínima de silêncio (segundos)

async function analyzeSilences(audioFile, label) {
  console.log(`\n🔍 Analisando silêncios em: ${label}`);
  console.log(`   Arquivo: ${audioFile}\n`);
  
  try {
    // Detectar todos os silêncios
    const { stdout } = await execAsync(`ffmpeg -i "${audioFile}" -af silencedetect=noise=${SILENCE_THRESHOLD}:d=${MIN_SILENCE_DURATION} -f null - 2>&1`);
    
    const silences = [];
    const lines = stdout.split('\n');
    
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
    
    console.log(`📊 Silêncios detectados: ${silences.length}`);
    silences.forEach((s, i) => {
      const minutes = Math.floor(s.start / 60);
      const seconds = (s.start % 60).toFixed(1);
      console.log(`   ${i + 1}. ${minutes}:${seconds.padStart(4, '0')} → ${s.duration.toFixed(2)}s`);
    });
    
    return silences;
    
  } catch (error) {
    console.error(`❌ Erro ao analisar: ${error.message}`);
    return [];
  }
}

async function getAudioDuration(audioFile) {
  const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`);
  return parseFloat(stdout.trim());
}

async function extractAudio(videoFile, outputFile) {
  console.log(`📤 Extraindo áudio de: ${videoFile}`);
  await execAsync(`ffmpeg -i "${videoFile}" -vn -acodec libmp3lame -q:a 2 "${outputFile}" -y`);
  console.log(`✅ Áudio extraído: ${outputFile}\n`);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, '0')}`;
}

function analyzeStructure(silences, duration) {
  console.log(`\n🧩 Estrutura de Blocos:`);
  
  const blocks = [];
  let lastEnd = 0;
  
  silences.forEach((silence, i) => {
    // Speech block before silence
    if (silence.start > lastEnd) {
      blocks.push({
        type: 'speech',
        start: lastEnd,
        end: silence.start,
        duration: silence.start - lastEnd
      });
    }
    
    // Silence block
    blocks.push({
      type: 'silence',
      start: silence.start,
      end: silence.end,
      duration: silence.duration
    });
    
    lastEnd = silence.end;
  });
  
  // Final speech block
  if (lastEnd < duration) {
    blocks.push({
      type: 'speech',
      start: lastEnd,
      end: duration,
      duration: duration - lastEnd
    });
  }
  
  blocks.forEach((block, i) => {
    const icon = block.type === 'speech' ? '🗣️' : '🔇';
    console.log(`   ${i + 1}. ${icon} ${block.type.toUpperCase()}: ${formatTime(block.start)} → ${formatTime(block.end)} (${block.duration.toFixed(2)}s)`);
  });
  
  return blocks;
}

function compareStructures(original, dubbed) {
  console.log(`\n⚖️  Comparação de Estruturas:\n`);
  
  const maxBlocks = Math.max(original.length, dubbed.length);
  
  console.log('   ORIGINAL                          DUBLADO                           DIFERENÇA');
  console.log('   ' + '─'.repeat(90));
  
  for (let i = 0; i < maxBlocks; i++) {
    const o = original[i];
    const d = dubbed[i];
    
    if (o && d) {
      const diff = d.duration - o.duration;
      const diffStr = diff >= 0 ? `+${diff.toFixed(1)}s` : `${diff.toFixed(1)}s`;
      const icon = Math.abs(diff) > 2 ? '❌' : '✅';
      
      console.log(`   ${i + 1}. ${o.type[0].toUpperCase()} ${o.duration.toFixed(1)}s (${formatTime(o.start)})      →      ${d.type[0].toUpperCase()} ${d.duration.toFixed(1)}s (${formatTime(d.start)})      ${icon} ${diffStr}`);
    } else if (o) {
      console.log(`   ${i + 1}. ${o.type[0].toUpperCase()} ${o.duration.toFixed(1)}s (${formatTime(o.start)})      →      ❌ AUSENTE`);
    } else if (d) {
      console.log(`   ${i + 1}. ❌ AUSENTE                            ${d.type[0].toUpperCase()} ${d.duration.toFixed(1)}s (${formatTime(d.start)})`);
    }
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   🎬 ANALISADOR DE SINCRONIZAÇÃO DE VÍDEO     ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.log('Uso: node analyze-sync.js <video_original.mp4> <video_dublado.mp4>');
    console.log('\nExemplo:');
    console.log('  node analyze-sync.js "video.mp4" "video_en.mp4"');
    process.exit(1);
  }
  
  const originalVideo = args[0];
  const dubbedVideo = args[1];
  
  if (!fs.existsSync(originalVideo)) {
    console.error(`❌ Arquivo não encontrado: ${originalVideo}`);
    process.exit(1);
  }
  
  if (!fs.existsSync(dubbedVideo)) {
    console.error(`❌ Arquivo não encontrado: ${dubbedVideo}`);
    process.exit(1);
  }
  
  // Extract audio from both videos
  const originalAudio = 'temp_original_audio.mp3';
  const dubbedAudio = 'temp_dubbed_audio.mp3';
  
  await extractAudio(originalVideo, originalAudio);
  await extractAudio(dubbedVideo, dubbedAudio);
  
  // Get durations
  const originalDuration = await getAudioDuration(originalAudio);
  const dubbedDuration = await getAudioDuration(dubbedAudio);
  
  console.log(`\n⏱️  DURAÇÕES:`);
  console.log(`   Original: ${formatTime(originalDuration)} (${originalDuration.toFixed(2)}s)`);
  console.log(`   Dublado:  ${formatTime(dubbedDuration)} (${dubbedDuration.toFixed(2)}s)`);
  console.log(`   Diferença: ${(dubbedDuration - originalDuration).toFixed(2)}s\n`);
  
  // Analyze silences
  const originalSilences = await analyzeSilences(originalAudio, 'ORIGINAL');
  const dubbedSilences = await analyzeSilences(dubbedAudio, 'DUBLADO');
  
  // Analyze structure
  const originalBlocks = analyzeStructure(originalSilences, originalDuration);
  console.log('');
  const dubbedBlocks = analyzeStructure(dubbedSilences, dubbedDuration);
  
  // Compare structures
  compareStructures(originalBlocks, dubbedBlocks);
  
  // Summary
  console.log(`\n📝 RESUMO:\n`);
  
  const speechBlocksOriginal = originalBlocks.filter(b => b.type === 'speech');
  const speechBlocksDubbed = dubbedBlocks.filter(b => b.type === 'speech');
  
  const totalSpeechOriginal = speechBlocksOriginal.reduce((sum, b) => sum + b.duration, 0);
  const totalSpeechDubbed = speechBlocksDubbed.reduce((sum, b) => sum + b.duration, 0);
  
  console.log(`   Blocos de fala original: ${speechBlocksOriginal.length} (total: ${totalSpeechOriginal.toFixed(1)}s)`);
  console.log(`   Blocos de fala dublado:  ${speechBlocksDubbed.length} (total: ${totalSpeechDubbed.toFixed(1)}s)`);
  console.log(`   Ratio de fala: ${((totalSpeechDubbed / totalSpeechOriginal) * 100).toFixed(1)}%`);
  
  const silencesOriginal = originalBlocks.filter(b => b.type === 'silence');
  const silencesDubbed = dubbedBlocks.filter(b => b.type === 'silence');
  
  const totalSilenceOriginal = silencesOriginal.reduce((sum, b) => sum + b.duration, 0);
  const totalSilenceDubbed = silencesDubbed.reduce((sum, b) => sum + b.duration, 0);
  
  console.log(`\n   Silêncios original: ${silencesOriginal.length} (total: ${totalSilenceOriginal.toFixed(1)}s)`);
  console.log(`   Silêncios dublado:  ${silencesDubbed.length} (total: ${totalSilenceDubbed.toFixed(1)}s)`);
  
  // Cleanup
  fs.unlinkSync(originalAudio);
  fs.unlinkSync(dubbedAudio);
  
  console.log(`\n✅ Análise completa!\n`);
}

main().catch(error => {
  console.error('\n❌ Erro:', error.message);
  process.exit(1);
});
