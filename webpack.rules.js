module.exports = [
  {
    test: /native_modules\/.+\.node$/,
    use: 'node-loader',
  },
  {
    test: /\.jsx?$/,
    exclude: /node_modules/,
    use: {
      loader: 'babel-loader',
      options: {
        presets: [
          ['@babel/preset-env', {
            targets: { electron: '35' },
          }],
          ['@babel/preset-react', {
            runtime: 'automatic',
          }],
        ],
      },
    },
  },
];
