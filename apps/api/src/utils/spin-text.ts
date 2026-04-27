export const spinText = (input: string) => {
  return input.replace(/\{([^{}]+)\}/g, (_match, variants: string) => {
    const options = variants.split("|").map((item) => item.trim()).filter(Boolean);
    if (options.length === 0) {
      return "";
    }

    const pick = Math.floor(Math.random() * options.length);
    return options[pick];
  });
};
