export const strong = ["don't do that", "not like that", "i said", "i told you", "we already discussed", "please don't", "that's not what i", "i never said", "i didn't ask for", "you misunderstood"];
export const weak = ["no", "wrong", "actually", "stop"];
export const explicit = ["remember this", "remember that", "save this as a memory", "save this to memory"];
export const negative = ["no worries", "no problem", "no thanks", "no need", "actually looks good", "actually looks great", "actually that's perfect", "actually that's correct", "actually that's right", "stop there", "stop here", "stop for now"];

export const normalizePhrase = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
