{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_latest;
    pnpm.enable = true;
  };
}
