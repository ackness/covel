### Fixed

- **Image navigation opens the panel that declares its destination.** Right-panel specs can declare `navTarget: "images"`; an image icon alone no longer captures navigation. Once panels finish loading, missing destinations clear the request and show a notice. Lazy loading and explicit loading retries retain the request.
