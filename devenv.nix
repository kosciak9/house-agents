{ pkgs, ... }:

{
  # E2E speaks its voice messages: espeak-ng says the text, ffmpeg makes it a
  # Telegram voice note (OGG Opus).
  packages = [
    pkgs.espeak-ng
    pkgs.ffmpeg
  ];

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_latest;
    pnpm.enable = true;
  };
}
