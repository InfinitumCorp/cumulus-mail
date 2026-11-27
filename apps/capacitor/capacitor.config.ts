import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.cumuluscloud.mail",
  appName: "Cumulus Mail",
  webDir: "www",
  server: { url: "https://mail.cumuluscloud.app", androidScheme: "https" },
};

export default config;
