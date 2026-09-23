import path from "node:path";

export function isForbiddenGovernedSecretPath(pathname: string): boolean {
  const basename = path.basename(pathname).toLowerCase();
  const extension = path.extname(basename);
  const segments = new Set(
    path
      .resolve(pathname)
      .split(path.sep)
      .map((segment) => segment.toLowerCase()),
  );
  return (
    segments.has("credentials") ||
    segments.has("secrets") ||
    segments.has(".aws") ||
    segments.has(".azure") ||
    segments.has(".config") ||
    segments.has(".docker") ||
    segments.has(".git") ||
    segments.has(".gnupg") ||
    segments.has(".kube") ||
    segments.has(".password-store") ||
    segments.has(".ssh") ||
    segments.has(".terraform.d") ||
    segments.has("auth-profiles.json") ||
    segments.has("oauth.json") ||
    basename === ".consul-token" ||
    basename === ".gitconfig" ||
    basename === ".npmrc" ||
    basename === ".vault-token" ||
    basename === ".yarnrc" ||
    basename === ".git-credentials" ||
    basename === ".netrc" ||
    basename === ".pypirc" ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    /^id_[a-z0-9_-]+$/u.test(basename) ||
    [".key", ".pem", ".p12", ".pfx", ".jks"].includes(extension)
  );
}
