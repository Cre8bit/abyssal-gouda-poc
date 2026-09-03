// Virtual modules provided by vite.config.ts.

declare module "virtual:lan-host" {
  /** The dev machine's LAN IPv4 ("" in a build, or when offline). */
  export const LAN_HOST: string;
}
