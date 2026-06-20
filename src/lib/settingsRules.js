import { prisma } from "./prisma.js";

export const toRuleNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getProgramSettings = async (salonId, key, fallback = {}) => {
  if (!prisma?.salonSetting?.findFirst) {
    return { ...fallback };
  }
  const row = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { advancedSettings: true }
  });
  const advancedSettings = typeof row?.advancedSettings === "object" && row.advancedSettings ? row.advancedSettings : {};
  const programSettings = typeof advancedSettings?.[key] === "object" && advancedSettings[key] ? advancedSettings[key] : {};
  return { ...fallback, ...programSettings };
};

export const ensureProgramEnabled = (settings, label = "Program") => {
  if (settings?.enabled === false) {
    const error = new Error(`${label} are disabled in settings`);
    error.status = 400;
    throw error;
  }
  return settings;
};
