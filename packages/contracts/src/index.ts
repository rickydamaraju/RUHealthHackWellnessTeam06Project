export interface RuntimeConfig {
  apiUrl: string; region: string; userPoolId: string; clientId: string;
  cognitoDomain: string; configured: boolean;
}
export interface Nutrition { carbs_g: number; protein_g: number; fat_g: number; fiber_g: number; calories: number }
export interface Food { id: string; name: string; per_100g: Nutrition; portions: { label: string; grams: number }[] }
export type MealPhotoContentType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/heic' | 'image/heif' | 'image/avif' | 'image/bmp' | 'image/tiff';
export interface MealPhoto { id: string; filename: string; content_type: MealPhotoContentType; size_bytes: number; status: 'awaiting_upload' | 'ready' }
export interface MealInput { request_id: string; description: string; eaten_at: string; entry_method: 'search' | 'text' | 'photo'; foods: { food_id: string; grams: number }[]; photo_id?: string }
export interface Meal { id: string; description: string; eaten_at: string; created_at: string; nutrition: Nutrition; foods: { food_id: string; name: string; grams: number; nutrition: Nutrition }[]; photo?: MealPhoto }
export interface Reading { timestamp: string; glucose_mg_dl: number }
export interface ImportStatus { id: string; filename: string; status: 'awaiting_upload' | 'processing' | 'ready' | 'failed'; error?: string; reading_count?: number }
export interface ActivityReading { timestamp: string; steps?: number; active_energy_kcal?: number; heart_rate_bpm?: number }
export interface ActivityImportStatus extends ImportStatus { content_type: 'text/csv' | 'application/zip' }
export type HealthMetric = 'heart_rate_bpm' | 'steps' | 'basal_energy_kcal' | 'active_energy_kcal';
export interface HealthSampleInput { source_id: string; metric: HealthMetric; start_at: string; end_at: string; value: number }
export interface WorkoutInput { source_id: string; activity_type: string; start_at: string; end_at: string; duration_seconds: number; energy_kcal?: number }
export interface HealthSyncInput { samples: HealthSampleInput[]; workouts: WorkoutInput[]; anchor?: string }
export interface HealthRecord { source_id: string; source: 'apple_health'; metric: HealthMetric | 'workout'; timestamp: string; end_timestamp: string; value?: number; duration_seconds?: number; energy_kcal?: number; activity_type?: string }
export type ConnectionState = 'not_connected' | 'connected' | 'connected_no_data' | 'denied' | 'reauthorization_required' | 'unavailable';
export interface Connections {
  apple_health: { status: 'not_connected' | 'connected' | 'connected_no_data'; record_count: number; last_synced_at?: string | null };
  dexcom: { configured: boolean; status: ConnectionState; reading_count: number; last_synced_at?: string | null; last_reading_at?: string | null };
}
export type DiabetesStatus = 'type_1' | 'type_2' | 'unknown' | 'no_diabetes';
export interface ProfileInput { first_name: string; last_name: string; age: number; height: number; height_unit: 'cm' | 'in'; weight: number; weight_unit: 'kg' | 'lb'; diabetes_status: DiabetesStatus }
export interface Profile extends ProfileInput { height_cm: number; weight_kg: number; created_at: string; updated_at: string }
export interface Interpretation { items: { name: string; grams: number | null; matches: Food[] }[]; requires_confirmation: true }
export interface PhotoAnalysis { items: { name: string; grams: number; confidence: number; matches: Food[] }[]; requires_confirmation: true; preview_url: string }
export interface Page<T> { items: T[]; has_more: boolean }
export interface Prediction {
  id: string; meal_id: string; created_at: string; model_version: string;
  baseline_mg_dl: number; curve: { minutes: number; glucose_mg_dl: number }[];
  peak_mg_dl: number; time_to_peak_minutes: number; excursion_mg_dl: number;
  feature_contributions: Record<string, unknown>[]; uncertainty: unknown | null;
  quality_flags: string[]; explanation: string; guardrail_status: 'passed' | 'blocked' | 'unavailable';
  input_summary: { meal_macros: Pick<Nutrition, 'carbs_g' | 'protein_g' | 'fat_g' | 'fiber_g'>; real_cgm_observations: number; apple_health_observations: Record<string, number>; prior_meals: number; dexcom_sandbox_excluded: boolean };
}
