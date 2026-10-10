export interface RuntimeConfig {
  apiUrl: string; region: string; userPoolId: string; clientId: string;
  cognitoDomain: string; configured: boolean;
}
export interface Nutrition { carbs_g: number; protein_g: number; fat_g: number; fiber_g: number; calories: number }
export interface Food { id: string; name: string; per_100g: Nutrition; portions: { label: string; grams: number }[] }
export interface MealPhoto { id: string; filename: string; content_type: 'image/jpeg' | 'image/png' | 'image/webp'; size_bytes: number; status: 'awaiting_upload' | 'ready' }
export interface MealInput { request_id: string; description: string; eaten_at: string; entry_method: 'search' | 'text' | 'photo'; foods: { food_id: string; grams: number }[]; photo_id?: string }
export interface Meal { id: string; description: string; eaten_at: string; created_at: string; nutrition: Nutrition; foods: { food_id: string; name: string; grams: number; nutrition: Nutrition }[]; photo?: MealPhoto }
export interface Reading { timestamp: string; glucose_mg_dl: number }
export interface ImportStatus { id: string; filename: string; status: 'awaiting_upload' | 'processing' | 'ready' | 'failed'; error?: string; reading_count?: number }
export interface Interpretation { items: { name: string; grams: number | null; matches: Food[] }[]; requires_confirmation: true }
export interface Page<T> { items: T[]; has_more: boolean }
export interface Prediction {
  id: string; meal_id: string; created_at: string; model_version: string;
  baseline_mg_dl: number; curve: { minutes: 30 | 60 | 90 | 120; glucose_mg_dl: number }[];
  peak_mg_dl: number; time_to_peak_minutes: number; excursion_mg_dl: number;
  feature_contributions: Record<string, unknown>[]; uncertainty: unknown | null;
  quality_flags: string[]; explanation: string; guardrail_status: 'passed' | 'blocked' | 'unavailable';
}
