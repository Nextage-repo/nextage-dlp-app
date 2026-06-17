const path = require("path");
const fs = require("fs");
const os = require("os");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = (env, argv) => {
  const isProduction = argv.mode === "production";

  return {
    mode: isProduction ? "production" : "development",
    devtool: isProduction ? "source-map" : "cheap-source-map",
    entry: {
      taskpane: "./src/taskpane/taskpane.ts",
      commands: "./src/commands/commands.ts",
    },
    output: {
      filename: "[name].js",
      path: path.resolve(__dirname, "dist"),
      clean: true,
      publicPath: "/",
      globalObject: "this",
      environment: {
        arrowFunction: false,
        const: false,
        destructuring: false,
        dynamicImport: false,
        forOf: false,
        module: false,
      },
    },
    target: ["web", "es5"],
    optimization: {
      minimize: isProduction,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            ecma: 5,
            compress: {
              arrows: false,
            },
            format: {
              ecma: 5,
              comments: false,
            },
          },
        }),
      ],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: "ts-loader",
            options: { transpileOnly: false },
          },
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    plugins: [
      new webpack.DefinePlugin({
        "process.env.AZURE_FUNCTIONS_URL": JSON.stringify(
          process.env.AZURE_FUNCTIONS_URL ||
            "https://nextage-dlp-app-gchqasbzeqgkccf7.westeurope-01.azurewebsites.net/api"
        ),
      }),
      new HtmlWebpackPlugin({
        template: "./src/taskpane/taskpane.html",
        filename: "taskpane.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        template: "./src/commands/commands.html",
        filename: "commands.html",
        chunks: ["commands"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "src/assets", to: "assets", noErrorOnMissing: true },
          // Canonical XML manifest (Outlook Web + New + Classic). It contains no
          // ${TOKEN} placeholders, so it ships to dist/ verbatim.
          { from: "manifest.xml", to: "manifest.xml" },
        ],
      }),
    ],
    devServer: {
      static: { directory: path.join(__dirname, "dist") },
      port: 3000,
      server: resolveHttpsServer(),
      allowedHosts: "all",
      headers: { "Access-Control-Allow-Origin": "*" },
      historyApiFallback: { rewrites: [{ from: /^\/taskpane/, to: "/taskpane.html" }] },
      // Disable ALL client-side injection (HMR + live reload WebSocket).
      // commands.js runs in Classic Outlook's JS-only runtime which has no window/document/WebSocket.
      hot: false,
      liveReload: false,
      client: false,
    },
  };
};

// Resolve a TRUSTED https cert for localhost so Outlook desktop will load the
// add-in. Looks in two places, in order:
//   1. ./certs/localhost.{key,crt}                 (committed/local certs)
//   2. ~/.office-addin-dev-certs/localhost.{key,crt} (created by:
//          npx office-addin-dev-certs install)
// Falls back to webpack's self-signed cert (browser-only; Outlook desktop will
// reject it — run the office-addin-dev-certs command, see README-LOCAL.md).
function resolveHttpsServer() {
  const candidates = [
    path.join(__dirname, "certs"),
    path.join(os.homedir(), ".office-addin-dev-certs"),
  ];
  for (const dir of candidates) {
    const key = path.join(dir, "localhost.key");
    const crt = path.join(dir, "localhost.crt");
    if (fs.existsSync(key) && fs.existsSync(crt)) {
      return {
        type: "https",
        options: { key: fs.readFileSync(key), cert: fs.readFileSync(crt) },
      };
    }
  }
  return "https";
}
