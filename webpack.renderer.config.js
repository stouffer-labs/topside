const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const rules = require('./webpack.rules');

rules.push({
  test: /\.css$/,
  use: [
    MiniCssExtractPlugin.loader,
    'css-loader',
    {
      loader: 'postcss-loader',
      options: {
        postcssOptions: {
          plugins: [
            require('tailwindcss'),
            require('autoprefixer'),
          ],
        },
      },
    },
  ],
});

rules.push({
  test: /\.(png|jpe?g|gif|svg|woff2?|eot|ttf|otf)$/i,
  type: 'asset/resource',
});

module.exports = {
  cache: false,
  module: {
    rules,
  },
  plugins: [
    new MiniCssExtractPlugin(),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.join(__dirname, 'renderer/overlay/audio-worklet.js'),
          to: 'audio-worklet.js',
        },
      ],
    }),
  ],
  resolve: {
    extensions: ['.js', '.jsx', '.json', '.css'],
  },
  devtool: 'source-map',
};
