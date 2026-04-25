/**
 * Closure-summary messages — sent when Arham logs a case for the reporter
 * into the Cases API. Opportunistic: cases handled by partner NGOs that
 * don't log into Arham's API will not get auto-summaries.
 *
 * If the message lands more than 24 hours after the reporter's last inbound,
 * WhatsApp's customer-service window has closed and we must use a
 * pre-approved Interakt template instead of free-form text.
 */
import type { Language } from "../types";
import type { ArhamCase } from "../clients/cases-api";

export interface ClosureMessageParts {
  /** Free-form text (used inside 24h window). */
  freeForm: string;
  /** Template name for outside-24h sends. Must be pre-approved in Interakt. */
  templateName: string;
  /** Body values for template substitution (positional). */
  templateBodyValues: string[];
}

const TEMPLATE_BY_LANG: Record<Language, string> = {
  en: "case_closure_summary_en",
  hi: "case_closure_summary_hi",
  mr: "case_closure_summary_mr",
  gu: "case_closure_summary_gu",
};

export function buildClosureMessage(
  language: Language,
  reportedDate: Date,
  caseRecord: ArhamCase
): ClosureMessageParts {
  const dateStr = reportedDate.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
  const animal = caseRecord.animal_type ?? "the animal";
  const treatment = caseRecord.treatment_summary ?? "treatment was provided";

  const freeForm = (() => {
    switch (language) {
      case "hi":
        return `${dateStr} को आपने जिस ${animal} की रिपोर्ट की थी — उसका इलाज हो गया है। ${treatment}. आपकी मदद के लिए धन्यवाद। 🙏`;
      case "mr":
        return `${dateStr} रोजी तुम्ही ज्या ${animal}ची माहिती दिली होती — त्याचा उपचार झाला आहे. ${treatment}. तुमच्या मदतीबद्दल आभार. 🙏`;
      case "gu":
        return `${dateStr} ના રોજ તમે જે ${animal} વિશે જણાવ્યું હતું — તેનો ઇલાજ થઈ ગયો છે. ${treatment}. તમારી મદદ બદલ આભાર. 🙏`;
      case "en":
      default:
        return `Update on the ${animal} you reported on ${dateStr} — ${treatment}. Thank you for stepping up. 🙏`;
    }
  })();

  return {
    freeForm,
    templateName: TEMPLATE_BY_LANG[language] ?? TEMPLATE_BY_LANG.en,
    templateBodyValues: [dateStr, animal, treatment],
  };
}
