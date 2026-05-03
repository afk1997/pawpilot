export type WorkbookIssueSeverity = "error" | "warning";

export interface WorkbookIssue {
  severity: WorkbookIssueSeverity;
  code: string;
  message: string;
  sheet?: string;
  row?: number;
  value?: string;
}

export interface KBArticleDraft {
  articleKey: string;
  category: string;
  title: string;
  body: string;
  language: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface KBArticleChunkDraft {
  articleKey: string;
  chunkIndex: number;
  content: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface KBFactDraft {
  factKey: string;
  category: string;
  label: string;
  value: string;
  valueType: "text" | "url" | "email" | "phone" | "money" | "boolean";
  sourceSheet: string;
  sourceRow: number;
}

export interface OfficialLinkDraft {
  linkKey: string;
  label: string;
  url: string;
  notes?: string | null;
  sourceSheet: string;
  sourceRow: number;
}

export interface ResponseTemplateDraft {
  templateKey: string;
  scenario: string;
  intent: string;
  language: string;
  template: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface EscalationRuleDraft {
  ruleKey: string;
  trigger: string;
  action: string;
  routeTo: string;
  sourceSheet: string;
  sourceRow: number;
}

export interface CoverageAreaDraft {
  coverageKey: string;
  city: string;
  area?: string | null;
  state: string;
  status: "active" | "launching_soon" | "unknown";
  aliases: string[];
  notes?: string | null;
  sourceSheet: string;
  sourceRow: number;
}

export interface AmbulanceDraft {
  label: string;
  category: string;
  city: string;
  area?: string | null;
  state: string;
  phone: string;
  phoneRaw: string;
  operatedBy: string;
  numberPlate?: string | null;
  areasCovered: string[];
  timings?: string | null;
  sourceSheet: string;
  sourceRow: number;
}

export interface ClinicDraft {
  label: string;
  city: string;
  area?: string | null;
  state: string;
  phone: string;
  phoneRaw: string;
  operatedBy: string;
  timings?: string | null;
  sourceSheet: string;
  sourceRow: number;
}

export interface ParsedWorkbook {
  source: {
    filePath: string;
    fileName: string;
    fileHash: string;
  };
  articles: KBArticleDraft[];
  chunks: KBArticleChunkDraft[];
  facts: KBFactDraft[];
  officialLinks: OfficialLinkDraft[];
  responseTemplates: ResponseTemplateDraft[];
  escalationRules: EscalationRuleDraft[];
  coverageAreas: CoverageAreaDraft[];
  ambulances: AmbulanceDraft[];
  clinics: ClinicDraft[];
  warnings: WorkbookIssue[];
  errors: WorkbookIssue[];
}

export interface WorkbookValidationReport {
  errors: WorkbookIssue[];
  warnings: WorkbookIssue[];
}
