{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_latest;
    pnpm.enable = true;
  };

  # Scripts load .env themselves (tsx --env-file); keep secrets out of the shell.
  dotenv.disableHint = true;
}
