// utils/getFeature.js
exports.getFeature = (subscription, key) => {
  const features = subscription?.features;
  if (!Array.isArray(features)) return undefined;
  return features.find((f) => f.key === key);
};
