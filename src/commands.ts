const prefix = "psm-";

export const commands = {
  setup: `${prefix}setup`,
  settings: `${prefix}settings`,
  migrateHermes: `${prefix}migrate-hermes`,
  inject: `${prefix}inject`,
  link: `${prefix}link`,
  consolidate: `${prefix}consolidate`,
  reclassify: `${prefix}reclassify`,
  pin: `${prefix}pin`,
} as const;
