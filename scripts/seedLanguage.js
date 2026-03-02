require('dotenv').config();
const mongoose = require('mongoose');
const Language = require('../models/language');

// === Paste from your payload ===
const payload = {
  languages: [
    { "code": "en", "name": "English" },
    { "code": "es", "name": "Spanish" },
    { "code": "pt", "name": "Portuguese" },
    { "code": "fr", "name": "French" },
    { "code": "ar", "name": "Arabic" },
    { "code": "ru", "name": "Russian" },
    { "code": "it", "name": "Italian" },
    { "code": "de", "name": "German" },
    { "code": "fa", "name": "Persian" },
    { "code": "id", "name": "Indonesian" },
    { "code": "tr", "name": "Turkish" },
    { "code": "ja", "name": "Japanese" },
    { "code": "pl", "name": "Polish" },
    { "code": "th", "name": "Thai" },
    { "code": "zh", "name": "Chinese" },
    { "code": "hi", "name": "Hindi" },
    { "code": "uk", "name": "Ukrainian" },
    { "code": "ms", "name": "Malay" },
    { "code": "ko", "name": "Korean" },
    { "code": "nl", "name": "Dutch" },
    { "code": "ne", "name": "Nepali" },
    { "code": "arz", "name": "Arabic (Egyptian)" },
    { "code": "az", "name": "Azerbaijani" },
    { "code": "pa", "name": "Punjabi" },
    { "code": "gu", "name": "Gujarati" },
    { "code": "sv", "name": "Swedish" },
    { "code": "kk", "name": "Kazakh" },
    { "code": "he", "name": "Hebrew" },
    { "code": "ro", "name": "Romanian" },
    { "code": "cs", "name": "Czech" },
    { "code": "ckb", "name": "Kurdish, Central" },
    { "code": "vi", "name": "Vietnamese" },
    { "code": "mr", "name": "Marathi" },
    { "code": "ur", "name": "Urdu" },
    { "code": "ky", "name": "Kirghiz" },
    { "code": "hu", "name": "Hungarian" },
    { "code": "el", "name": "Greek" },
    { "code": "bn", "name": "Bengali" },
    { "code": "ml", "name": "Malayalam" },
    { "code": "ca", "name": "Catalan" },
    { "code": "fi", "name": "Finnish" },
    { "code": "no", "name": "Norwegian" },
    { "code": "da", "name": "Danish" },
    { "code": "bg", "name": "Bulgarian" },
    { "code": "sr", "name": "Serbian" },
    { "code": "sw", "name": "Swahili" },
    { "code": "hr", "name": "Croatian" },
    { "code": "tl", "name": "Tagalog" },
    { "code": "sq", "name": "Albanian" },
    { "code": "sk", "name": "Slovak" },
    { "code": "ta", "name": "Tamil" },
    { "code": "sh", "name": "Serbo-Croatian" },
    { "code": "sl", "name": "Slovenian" },
    { "code": "km", "name": "Central Khmer" },
    { "code": "mk", "name": "Macedonian" },
    { "code": "ps", "name": "Pushto" },
    { "code": "kn", "name": "Kannada" },
    { "code": "hy", "name": "Armenian" },
    { "code": "uz", "name": "Uzbek" },
    { "code": "gl", "name": "Galician" },
    { "code": "ce", "name": "Chechen" },
    { "code": "af", "name": "Afrikaans" },
    { "code": "lt", "name": "Lithuanian" },
    { "code": "azb", "name": "Azerbaijani, South" },
    { "code": "si", "name": "Sinhala" },
    { "code": "ceb", "name": "Cebuano" },
    { "code": "et", "name": "Estonian" },
    { "code": "as", "name": "Assamese" },
    { "code": "tt", "name": "Tatar" },
    { "code": "ka", "name": "Georgian" },
    { "code": "tg", "name": "Tajik" },
    { "code": "lv", "name": "Latvian" },
    { "code": "pnb", "name": "Punjabi, Western" },
    { "code": "lo", "name": "Lao" },
    { "code": "te", "name": "Telugu" },
    { "code": "bs", "name": "Bosnian" },
    { "code": "am", "name": "Amharic" },
    { "code": "my", "name": "Burmese" },
    { "code": "mn", "name": "Mongolian" },
    { "code": "is", "name": "Icelandic" },
    { "code": "sah", "name": "Sakha" },
    { "code": "or", "name": "Oriya (Odia/Odiya)" },
    { "code": "ku", "name": "Kurdish" },
    { "code": "mzn", "name": "Mazanderani" },
    { "code": "sd", "name": "Sindhi" },
    { "code": "gd", "name": "Gaelic (Scots)" },
    { "code": "be", "name": "Belarusian" },
    { "code": "fy", "name": "Frisian, Western" },
    { "code": "so", "name": "Somali" },
    { "code": "als", "name": "Albanian (Tosk)" },
    { "code": "mhr", "name": "Mari, Eastern" },
    { "code": "war", "name": "Waray" },
    { "code": "ie", "name": "Interlingue" },
    { "code": "ba", "name": "Bashkir" },
    { "code": "dv", "name": "Divehi" },
    { "code": "tk", "name": "Turkmen" },
    { "code": "ia", "name": "Interlingua" },
    { "code": "nds", "name": "Low German" },
    { "code": "jv", "name": "Javanese" },
    { "code": "jbo", "name": "Lojban" },
    { "code": "ug", "name": "Uighur" },
    { "code": "bo", "name": "Tibetan" },
    { "code": "gn", "name": "Guarani" },
    { "code": "nap", "name": "Neapolitan" },
    { "code": "ilo", "name": "Iloko" },
    { "code": "ga", "name": "Irish" },
    { "code": "mg", "name": "Malagasy" },
    { "code": "su", "name": "Sundanese" },
    { "code": "yue", "name": "Yue Chinese" },
    { "code": "lez", "name": "Lezghian" },
    { "code": "io", "name": "Ido" },
    { "code": "bh", "name": "Bihari" },
    { "code": "kw", "name": "Cornish" },
    { "code": "ht", "name": "Haitian" },
    { "code": "min", "name": "Minangkabau" },
    { "code": "new", "name": "Newari" },
    { "code": "mai", "name": "Maithili" },
    { "code": "ast", "name": "Asturian" },
    { "code": "yi", "name": "Yiddish" },
    { "code": "cv", "name": "Chuvash" },
    { "code": "pms", "name": "Piedmontese" },
    { "code": "sa", "name": "Sanskrit" },
    { "code": "hsb", "name": "Sorbian, Upper" },
    { "code": "sco", "name": "Scots" },
    { "code": "pam", "name": "Pampanga" },
    { "code": "xmf", "name": "Mingrelian" },
    { "code": "xh", "name": "Xhosa" },
    { "code": "bar", "name": "Bavarian" },
    { "code": "wuu", "name": "Wu Chinese" },
    { "code": "krc", "name": "Karachay-Balkar" },
    { "code": "lrc", "name": "Luri, Northern" },
    { "code": "bpy", "name": "Bishnupriya Manipuri" },
    { "code": "zu", "name": "Zulu" },
    { "code": "mrj", "name": "Mari, Western" },
    { "code": "rw", "name": "Kinyarwanda" },
    { "code": "gom", "name": "Konkani, Goan" },
    { "code": "os", "name": "Ossetian" },
    { "code": "cbk", "name": "Chavacano" },
    { "code": "eml", "name": "Emiliano-Romagnolo" },
    { "code": "lmo", "name": "Lombard" },
    { "code": "gv", "name": "Manx" },
    { "code": "scn", "name": "Sicilian" },
    { "code": "li", "name": "Limburgish" },
    { "code": "rm", "name": "Raeto-Romance" },
    { "code": "myv", "name": "Erzya" },
    { "code": "bcl", "name": "Bicolano, Central" },
    { "code": "av", "name": "Avaric" },
    { "code": "kv", "name": "Komi" },
    { "code": "bxr", "name": "Buriat, Russia" },
    { "code": "vep", "name": "Veps" },
    { "code": "sc", "name": "Sardinian" },
    { "code": "xal", "name": "Kalmyk" },
    { "code": "diq", "name": "Dimli" },
    { "code": "tyv", "name": "Tuvinian" },
    { "code": "nah", "name": "Nahuatl languages" },
    { "code": "mwl", "name": "Mirandese" },
    { "code": "yo", "name": "Yoruba" },
    { "code": "vec", "name": "Venetian" },
    { "code": "rue", "name": "Rusyn" },
    { "code": "dty", "name": "Dotyali" },
    { "code": "dsb", "name": "Sorbian, Lower" },
    { "code": "pfl", "name": "Pfaelzisch" },
    { "code": "frr", "name": "Frisian, Northern" },
    { "code": "co", "name": "Corsican" }
  ],
  total: 164,
  error: false
};
  
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Missing MONGODB_URI in environment');

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const languages = Array.isArray(payload.languages) ? payload.languages : [];
  if (!languages.length) throw new Error('No languages provided');

  // Upsert all languages by code
  const ops = languages.map(({ code, name }) => ({
    updateOne: {
      filter: { code },
      update: { $set: { code, name } },
      upsert: true
    }
  }));

  const result = await Language.bulkWrite(ops, { ordered: false });
  const total = await Language.countDocuments();

  console.log('Seed complete:', {
    matched: result.matchedCount,
    modified: result.modifiedCount,
    upserted: result.upsertedCount,
    totalInDB: total
  });

  await mongoose.disconnect();
  console.log('Disconnected');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});