// Run by the root `prepare` script. Installs the git hooks for a developer checkout and does nothing
// in CI, in the Docker build, or where devDependencies (and so husky) are absent. This is the approach
// recommended by husky for CI and production installs: https://typicode.github.io/husky/how-to.html
if (
  process.env.NODE_ENV === "production" ||
  process.env.CI === "true" ||
  process.env.HUSKY === "0"
) {
  process.exit(0);
}
try {
  const husky = (await import("husky")).default;
  console.log(husky());
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
