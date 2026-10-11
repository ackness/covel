import { useEffect, useState } from "react";
import { COPY, initialLang, rememberLang, type Lang } from "./copy.js";
import { Header } from "./components/Header.js";
import { Hero } from "./components/Hero.js";
import { Pillars } from "./components/Pillars.js";
import { CorePlugins } from "./components/CorePlugins.js";
import { Worlds } from "./components/Worlds.js";
import { Closing } from "./components/Closing.js";
import { useDownload } from "./download.js";

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const copy = COPY[lang];
  const download = useDownload();

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = copy.meta.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", copy.meta.description);
  }, [lang, copy]);

  const toggleLang = () => {
    const next: Lang = lang === "zh" ? "en" : "zh";
    rememberLang(next);
    setLang(next);
  };

  return (
    <div className="min-h-dvh overflow-x-clip">
      <Header copy={copy} download={download} onToggleLang={toggleLang} />
      <main>
        <Hero copy={copy} download={download} />
        <Pillars copy={copy} />
        <CorePlugins copy={copy} />
        <Worlds copy={copy} />
      </main>
      <Closing copy={copy} download={download} />
    </div>
  );
}
