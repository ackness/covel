function normalizeLocation(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

/** Scene names, marking `name` and the first `locationRef` part as the place itself. */
function sceneNames(scene) {
  return [scene.name, ...String(scene.locationRef ?? "").split("/")]
    .map((name, index) => ({
      name: normalizeLocation(name),
      isPlace: index < 2,
    }))
    .filter(({ name }) => name);
}

/**
 * The registry scene that a location reported by the narrative shows, or null.
 *
 * 1. A scene one of whose names is the location.
 * 2. A scene one of whose names is inside the location ("图书馆二楼" shows the
 *    scene named "图书馆"). Its own place names (`name` and the first
 *    `locationRef` part) outrank sub-locations (the later parts); the longest
 *    name within the same rank wins.
 * 3. A scene one of whose names has the location inside it ("海堤" shows
 *    "樱坂海堤"), only when no other scene has such a name: a fragment that two
 *    scenes share shows neither.
 *
 * @param {ReadonlyArray<unknown>} scenes
 * @param {string} location
 */
export function matchScene(scenes, location) {
  const wanted = normalizeLocation(location);
  if (!wanted) return null;
  const entries = scenes
    .filter(
      (scene) =>
        Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
    )
    .map((scene) => ({ scene, names: sceneNames(scene) }));

  const exact = entries.find(({ names }) =>
    names.some(({ name }) => name === wanted),
  );
  if (exact) return exact.scene;

  let inside = null;
  let insideLength = 0;
  let insideIsPlace = false;
  for (const { scene, names } of entries) {
    for (const { name, isPlace } of names) {
      if (
        wanted.includes(name) &&
        ((isPlace && !insideIsPlace) ||
          (isPlace === insideIsPlace && name.length > insideLength))
      ) {
        inside = scene;
        insideLength = name.length;
        insideIsPlace = isPlace;
      }
    }
  }
  if (inside) return inside;

  const around = entries.filter(({ names }) =>
    names.some(({ name }) => name.includes(wanted)),
  );
  return around.length === 1 ? around[0].scene : null;
}
