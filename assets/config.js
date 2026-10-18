export const CONFIG = Object.freeze({
  studioName: "Studio Emille Cassiane",
  whatsappE164: "", // Somente números, com DDI e DDD. Ex.: 5511999999999
  address: "", // Preencha apenas se quiser exibir o endereço publicamente.
  instagramUrl: "",
  timezone: "America/Araguaina",
  recaptchaV3SiteKey: "", // Opcional: configure App Check depois de registrar o site.
  authorizedAdminUids: ["4zC1SQs7YRQ0FfkGARdImqu2w7z1"],
  firebase: Object.freeze({
    apiKey: "AIzaSyDLaxf_tYSc4t7ZzE_VSSbKyQyUqS3rSWQ",
    authDomain: "studio-cassiana-emille.firebaseapp.com",
    projectId: "studio-cassiana-emille",
    storageBucket: "studio-cassiana-emille.firebasestorage.app",
    messagingSenderId: "90344996694",
    appId: "1:90344996694:web:75400f251b9397b7dc20f7",
    measurementId: "G-TV1M17LW29",
  }),
});

// Valores de exemplo para a primeira configuração no painel. Revise antes de ativar pedidos.
export const DEFAULT_SCHEDULE = Object.freeze({
  enabled: false,
  openMinute: 9 * 60,
  closeMinute: 18 * 60,
  breakStartMinute: 12 * 60,
  breakEndMinute: 13 * 60,
  workingDays: [1, 2, 3, 4, 5, 6],
  holidays: [], // Inteiros: dias desde 1970-01-01 no calendário local do studio.
  minimumLeadMinutes: 120,
  daysAhead: 60,
  retentionDays: 60,
  retentionEnabled: false,
});
