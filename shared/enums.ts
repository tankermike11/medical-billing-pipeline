export enum DataSource {
  CFPB = 'CFPB',
  REDDIT = 'REDDIT',
}

export enum AnalysisStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

export enum CfpbComplaintStatus {
  CLOSED_WITH_EXPLANATION = 'Closed with explanation',
  CLOSED_WITH_MONETARY_RELIEF = 'Closed with monetary relief',
  CLOSED_WITH_NON_MONETARY_RELIEF = 'Closed with non-monetary relief',
  CLOSED_WITHOUT_RELIEF = 'Closed without relief',
  IN_PROGRESS = 'In progress',
  UNTIMELY_RESPONSE = 'Untimely response',
}

export enum RequirementPriority {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}
