module.exports = {
  entry: './main.js',
  module: {
    rules: require('./webpack.rules'),
  },
  resolve: {
    extensions: ['.js', '.json'],
  },
  externals: [
    function ({ request }, callback) {
      const nativeExternals = [
        '@kutalia/whisper-node-addon',
        'active-window-addon',
        'mlx-inference-addon',
        '@huggingface/transformers',
        'bufferutil',
        'utf-8-validate',
      ];
      if (nativeExternals.includes(request)) {
        return callback(null, `commonjs ${request}`);
      }
      if (request === 'electron-squirrel-startup') {
        return callback(null, `commonjs ${request}`);
      }
      callback();
    },
  ],
  devtool: 'source-map',
};
