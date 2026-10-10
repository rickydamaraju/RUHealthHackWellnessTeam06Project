import type { ActivityImportStatus, ActivityReading, Food, Meal, MealInput, MealPhoto, Reading, ImportStatus, Interpretation, PhotoAnalysis, Page, Prediction } from '@glucose-compass/contracts';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// No browser APIs here: future native clients supply their own token provider.
export function createApi(baseUrl: string, accessToken: () => Promise<string>) {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const token = await accessToken();
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.detail;
      const message = typeof detail === 'string' ? detail : detail?.message ?? (response.status === 422 ? 'Check the fields and try again.' : 'The request could not be completed.');
      throw new ApiError(response.status, message);
    }
    return result as T;
  }
  return {
    me: () => request<{ id: string; model_connected: boolean; text_interpretation_enabled: boolean }>('/me'),
    foods: (query: string) => request<{ items: Food[] }>(`/foods?q=${encodeURIComponent(query)}`),
    interpret: (text: string) => request<Interpretation>('/meals/interpret', { text }),
    meals: () => request<Page<Meal>>('/meals'),
    saveMeal: (meal: MealInput) => request<Meal>('/meals', meal),
    startMealPhoto: (filename: string, contentType: MealPhoto['content_type'], sizeBytes: number) => request<{ photo: MealPhoto; upload: { url: string; fields: Record<string, string> } }>('/meal-photos', { filename, content_type: contentType, size_bytes: sizeBytes }),
    completeMealPhoto: (photoId: string) => request<MealPhoto>(`/meal-photos/${encodeURIComponent(photoId)}/complete`, {}),
    analyzeMealPhoto: (photoId: string) => request<PhotoAnalysis>(`/meal-photos/${encodeURIComponent(photoId)}/analyze`, {}),
    mealPhotoPreview: (photoId: string) => request<{ preview_url: string }>(`/meal-photos/${encodeURIComponent(photoId)}/preview`),
    readings: () => request<Page<Reading>>('/cgm'),
    startImport: (filename: string, unit: 'mg/dL' | 'mmol/L') => request<{ import: ImportStatus; upload: { url: string; fields: Record<string, string> } }>('/imports', { filename, unit }),
    importStatus: (id: string) => request<ImportStatus>(`/imports/${encodeURIComponent(id)}`),
    activity: () => request<Page<ActivityReading>>('/activity'),
    startActivityImport: (filename: string, contentType: 'text/csv' | 'application/zip') => request<{ import: ActivityImportStatus; upload: { url: string; fields: Record<string, string> } }>('/activity-imports', { filename, content_type: contentType }),
    activityImportStatus: (id: string) => request<ActivityImportStatus>(`/activity-imports/${encodeURIComponent(id)}`),
    predict: (mealId: string) => request<Prediction>('/predictions', { meal_id: mealId }),
  };
}
export type Api = ReturnType<typeof createApi>;
