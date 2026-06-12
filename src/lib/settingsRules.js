import { prisma } from "./prisma.js";

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

export const toRuleNumber = (value, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export const getSalonAdvancedSettings = async (salonId) => {
  const row = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { advancedSettings: true }
  });
  return asObject(row?.advancedSettings);
};

export const getProgramSettings = async (salonId, key, defaults = {}) => {
  const advancedSettings = await getSalonAdvancedSettings(salonId);
  return { ...defaults, ...asObject(advancedSettings[key]) };
};

export const ensureProgramEnabled = (settings, label) => {
  if (settings.enabled === false) {
    const error = new Error(`${label} is disabled in salon settings`);
    error.status = 400;
    throw error;
  }
};
