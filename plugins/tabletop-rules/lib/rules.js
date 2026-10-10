// Standalone package: resolve scripts with Intl without relying on host workspace imports.
export function pickLocaleText(locale, zh, en) {
  try {
    const tag = new Intl.Locale(locale ?? "en-US").maximize();
    return tag.language === "zh" && tag.script === "Hans" ? zh : en;
  } catch {
    return en;
  }
}

/**
 * The text in the session's language, from this plugin's `locales/` files.
 * The same contract as `translate` of `@covel/plugin-handlers-utils`, which a
 * standalone package does not import: the host passes the translations as
 * `ctx.messages`.
 */
export function translate(ctx, text, params) {
  const translations = ctx?.messages?.translations;
  const template =
    translations && Object.hasOwn(translations, text)
      ? translations[text]
      : text;
  if (!params) return template;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function label(value, locale) {
  if (typeof value === "string") return value;
  const fallback = value?.["en-US"] ?? value?.en ?? "Attribute";
  return (
    value?.[locale] ??
    pickLocaleText(locale, value?.["zh-CN"] ?? value?.zh ?? fallback, fallback)
  );
}

/**
 * Resolve the point-buy rules. World-authored configuration wins and is
 * validated strictly (authoring errors must fail loudly); without it the
 * rules are derived from the world schema's bounded integer `abilities`
 * attributes. Returns null when neither source yields an allocatable
 * attribute so callers can skip allocation silently.
 */
export function creationRules(schema, configured, locale) {
  if (configured) {
    const error = validateRules(configured);
    if (error) throw new Error(error);
    if (schema?.attributes) {
      for (const attribute of configured.attributes) {
        const declared = schema.attributes.find(
          (field) => field.id === attribute.id,
        );
        if (
          !declared ||
          declared.type !== "number" ||
          (typeof declared.min === "number" && attribute.base < declared.min) ||
          (typeof declared.max === "number" && attribute.max > declared.max)
        ) {
          throw new Error(
            `Point-buy attribute ${attribute.id} does not match the world schema`,
          );
        }
      }
    }
    return configured;
  }
  // Only abilities opt into this default rule; health and other resources do not.
  const attributes = (schema?.attributes ?? [])
    .filter(
      (attribute) =>
        attribute.type === "number" &&
        attribute.category === "abilities" &&
        Number.isInteger(attribute.min) &&
        Number.isInteger(attribute.max) &&
        Number.isInteger(attribute.defaultValue) &&
        attribute.defaultValue >= attribute.min &&
        attribute.defaultValue < attribute.max,
    )
    .map((attribute) => ({
      id: attribute.id,
      label: label(attribute.name, locale),
      base: attribute.defaultValue,
      max: attribute.max,
    }));
  if (!attributes.length) return null;
  const rules = {
    budget: Math.min(
      4,
      attributes.reduce(
        (sum, attribute) => sum + attribute.max - attribute.base,
        0,
      ),
    ),
    attributes,
  };
  const error = validateRules(rules);
  if (error) throw new Error(error);
  return rules;
}

export function validateRules(rules) {
  if (
    !rules ||
    !Number.isSafeInteger(rules.budget) ||
    rules.budget < 0 ||
    rules.budget > 10000 ||
    !Array.isArray(rules.attributes) ||
    !rules.attributes.length ||
    rules.attributes.length > 30
  )
    return "Invalid point-buy rules";
  const ids = new Set();
  for (const attribute of rules.attributes) {
    if (
      !attribute ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(attribute.id) ||
      [
        "name",
        "characterName",
        "background",
        "constructor",
        "prototype",
        "__proto__",
      ].includes(attribute.id) ||
      ids.has(attribute.id) ||
      typeof attribute.label !== "string" ||
      !Number.isSafeInteger(attribute.base) ||
      !Number.isSafeInteger(attribute.max) ||
      attribute.base > attribute.max ||
      attribute.max - attribute.base > 10000
    )
      return "Invalid allocatable attribute";
    ids.add(attribute.id);
  }
  if (
    rules.budget >
    rules.attributes.reduce(
      (sum, attribute) => sum + attribute.max - attribute.base,
      0,
    )
  )
    return "Point budget exceeds attribute capacity";
}

/**
 * Validate an allocation-only submission: every attribute must be an integer
 * within its range and the budget must be spent exactly. The character name
 * belongs to the character-creation form, not to point allocation.
 *
 * The player reads the returned text. `ctx` (the form validator's third
 * argument, or a runtime context) gives it in the session's language.
 */
export function validateAllocation(values, rules, ctx) {
  const invalid = validateRules(rules);
  if (invalid) return invalid;
  let spent = 0;
  for (const attribute of rules.attributes) {
    const value = values[attribute.id];
    if (
      !Number.isSafeInteger(value) ||
      value < attribute.base ||
      value > attribute.max
    )
      return translate(
        ctx,
        "{label}: enter a whole number from {min} to {max}",
        { label: attribute.label, min: attribute.base, max: attribute.max },
      );
    spent += value - attribute.base;
  }
  if (spent !== rules.budget)
    return translate(
      ctx,
      "Allocate exactly {budget} points; you have allocated {spent}",
      { budget: rules.budget, spent },
    );
}
