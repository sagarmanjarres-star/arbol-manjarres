// Shared "day/month/year, any of which may be unknown" formatting used by
// both the tree cards (birth/death) and the relationship list (marriage).

export const MONTHS_ES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const MONTHS_ES_LONG = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Renders whatever precision is known: "15 mar 1958", "mar 1958", or "1958".
// Day/month with no year isn't useful on its own, so it's dropped.
export function formatPartialDate(day, month, year) {
  if (!year) return '';
  if (month && day) return `${day} ${MONTHS_ES_SHORT[month - 1]} ${year}`;
  if (month) return `${MONTHS_ES_SHORT[month - 1]} ${year}`;
  return `${year}`;
}
