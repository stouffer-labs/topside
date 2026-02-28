const https = require('https');
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const MODELS = {
  'ggml-tiny.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  'ggml-base.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  'ggml-small.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  'ggml-medium.en.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
  'ggml-large-v3.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
  'ggml-large-v3-turbo.bin': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
};

function downloadModel(modelFile, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    const url = MODELS[modelFile];
    if (!url) return reject(new Error(`Unknown model: ${modelFile}`));

    const destPath = path.join(destDir, modelFile);
    const tmpPath = destPath + '.tmp';

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // If already downloaded, skip
    if (fs.existsSync(destPath)) {
      return resolve(destPath);
    }

    log('MODEL', `Downloading ${modelFile}...`);

    const download = (downloadUrl) => {
      const proto = downloadUrl.startsWith('https') ? https : require('http');
      proto.get(downloadUrl, (res) => {
        // Follow redirects (Hugging Face uses 302)
        if (res.statusCode === 301 || res.statusCode === 302) {
          return download(res.headers.location);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;

        const file = fs.createWriteStream(tmpPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            onProgress({
              percent: Math.round((downloadedBytes / totalBytes) * 100),
              downloaded: downloadedBytes,
              total: totalBytes,
            });
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          // Rename tmp to final
          fs.renameSync(tmpPath, destPath);
          log('MODEL', `Download complete: ${modelFile}`);
          resolve(destPath);
        });

        file.on('error', (err) => {
          fs.unlink(tmpPath, () => {});
          reject(err);
        });
      }).on('error', reject);
    };

    download(url);
  });
}

module.exports = { downloadModel, MODELS };
