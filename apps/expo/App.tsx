import { WebView } from "react-native-webview";

/** The installed app is the website. Nothing here restyles mail. */
export default function App() {
  return <WebView source={{ uri: "https://mail.cumuluscloud.app" }} />;
}
