import { useEffect, useState } from "react";
import {
  COPY,
  LANGUAGES,
  initialLang,
  rememberLang,
  type Lang,
} from "./copy.js";
import { Header } from "./components/Header.js";
import { Hero } from "./components/Hero.js";
import { Pillars } from "./components/Pillars.js";
import { Creation } from "./components/Creation.js";
import { PluginWorkbench } from "./components/PluginWorkbench.js";
import { Worlds } from "./components/Worlds.js";
import { Closing } from "./components/Closing.js";
import { Downloads } from "./components/Downloads.js";
import { useDownload } from "./download.js";

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const copy = COPY[lang];
  const download = useDownload();

  useEffect(() => {
    document.documentElement.lang = LANGUAGES[lang].tag;
    document.title = copy.meta.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", copy.meta.description);
  }, [lang, copy]);

  const selectLang = (next: Lang) => {
    rememberLang(next);
    setLang(next);
  };

  return (
    <div className="min-h-dvh overflow-x-clip">
      <Header copy={copy} lang={lang} onSelectLang={selectLang} />
      <main>
        <Hero copy={copy} />
        <Pillars copy={copy} />
        <PluginWorkbench copy={copy} />
        <Creation copy={copy} />
        <Worlds copy={copy} />
        <Downloads copy={copy} download={download} />
      </main>
      <Closing copy={copy} />
    </div>
  );
}
