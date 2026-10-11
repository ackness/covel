import { useEffect, useState } from "react";
import { COPY, initialLang, rememberLang, type Lang } from "./copy.js";
import { Header } from "./components/Header.js";
import { Hero } from "./components/Hero.js";
import { Play } from "./components/Play.js";
import { Worlds } from "./components/Worlds.js";
import { Features } from "./components/Features.js";
import { Creators } from "./components/Creators.js";
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
        <Play copy={copy} />
        <Worlds copy={copy} />
        <Features copy={copy} />
        <Creators copy={copy} />
      </main>
      <Closing copy={copy} download={download} />
    </div>
  );
}
