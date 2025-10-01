import 'dotenv/config';
import OpenAI from 'openai';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function dubVideo(inputVideo, outputVideo) {
  console.log('🎬 Starting video dubbing process...\n');

  // Step 1: Extract audio from video
  console.log('📤 Extracting audio from video...');
  const audioFile = 'temp_audio.mp3';
  await execAsync(`ffmpeg -i "${inputVideo}" -vn -acodec libmp3lame -q:a 2 "${audioFile}" -y`);
  console.log('✅ Audio extracted\n');

  // Step 2: Transcribe Portuguese audio to text
  console.log('🎙️  Transcribing Portuguese audio...');
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioFile),
    model: 'gpt-4o-mini-transcribe',
    language: 'pt'
  });
  console.log('✅ Portuguese transcription:', transcription.text.substring(0, 100) + '...\n');

  // Step 3: Translate Portuguese text to English using GPT
  console.log('🌐 Translating to English...');
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
  console.log('✅ English translation:', englishText.substring(0, 100) + '...\n');

  // Step 4: Generate English speech using TTS
  console.log('🔊 Generating English speech...');
  const englishAudioFile = 'english_audio.mp3';
  const speechResponse = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: 'onyx', // Options: alloy, echo, fable, onyx, nova, shimmer
    input: englishText,
  });

  const buffer = Buffer.from(await speechResponse.arrayBuffer());
  fs.writeFileSync(englishAudioFile, buffer);
  console.log('✅ English audio generated\n');

  // Step 5: Get video duration to check if we need to adjust audio speed
  console.log('⏱️  Checking video/audio duration...');
  const { stdout: videoInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputVideo}"`);
  const videoDuration = parseFloat(videoInfo.trim());

  const { stdout: audioInfo } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${englishAudioFile}"`);
  const audioDuration = parseFloat(audioInfo.trim());

  console.log(`Video duration: ${videoDuration.toFixed(2)}s`);
  console.log(`Audio duration: ${audioDuration.toFixed(2)}s\n`);

  // Step 6: Replace audio in video (with speed adjustment if needed)
  console.log('🎥 Replacing audio in video...');

  let audioFilter = '';
  const speedRatio = videoDuration / audioDuration;

  // Only adjust if difference is significant (more than 5%)
  if (Math.abs(speedRatio - 1) > 0.05) {
    console.log(`⚙️  Adjusting audio speed by ${(speedRatio * 100).toFixed(1)}% to match video duration...`);
    audioFilter = `-filter:a "atempo=${speedRatio}"`;
  }

  await execAsync(`ffmpeg -i "${inputVideo}" -i "${englishAudioFile}" -c:v copy ${audioFilter} -map 0:v:0 -map 1:a:0 -shortest "${outputVideo}" -y`);
  console.log('✅ Video with English dub created\n');

  // Cleanup
  console.log('🧹 Cleaning up temporary files...');
  fs.unlinkSync(audioFile);
  fs.unlinkSync(englishAudioFile);
  console.log('✅ Cleanup complete\n');

  console.log(`🎉 Done! Your dubbed video is ready: ${outputVideo}`);
}

// Main execution
const inputVideo = 'ruicostapimenta.mp4';
const outputVideo = 'ruicostapimenta_english.mp4';

dubVideo(inputVideo, outputVideo).catch(error => {
  console.error('❌ Error:', error.message);

  // Cleanup on error
  try {
    if (fs.existsSync('temp_audio.mp3')) fs.unlinkSync('temp_audio.mp3');
    if (fs.existsSync('english_audio.mp3')) fs.unlinkSync('english_audio.mp3');
  } catch (e) {}

  process.exit(1);
});