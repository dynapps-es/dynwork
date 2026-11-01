// The desktop build bundles CSS imports; vite/client would declare them, but this package does not depend on Vite.
declare module "*.css" {}
