import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import {
  clearBackgroundTypes,
  configureBackgroundTypes,
  isHealthDataAvailable,
  queryQuantitySamplesWithAnchor,
  queryWorkoutSamplesWithAnchor,
  requestAuthorization,
  subscribeToChanges,
  UpdateFrequency,
  WorkoutTypeIdentifier,
} from '@kingstinct/react-native-healthkit';
import type { Api } from '@glucose-compass/api-client';
import type { HealthMetric, HealthSampleInput, WorkoutInput } from '@glucose-compass/contracts';

const quantities = [
  { id: 'HKQuantityTypeIdentifierHeartRate' as const, metric: 'heart_rate_bpm' as HealthMetric, unit: 'count/min' as const },
  { id: 'HKQuantityTypeIdentifierStepCount' as const, metric: 'steps' as HealthMetric, unit: 'count' as const },
  { id: 'HKQuantityTypeIdentifierBasalEnergyBurned' as const, metric: 'basal_energy_kcal' as HealthMetric, unit: 'kcal' as const },
  { id: 'HKQuantityTypeIdentifierActiveEnergyBurned' as const, metric: 'active_energy_kcal' as HealthMetric, unit: 'kcal' as const },
];
const observedTypes = [...quantities.map(item => item.id), WorkoutTypeIdentifier];

interface HealthCursor { startAt: string; anchors: Record<string, string> }
const cursorKey = (userId: string) => `health-cursors-${userId}`;

async function loadCursor(userId: string): Promise<HealthCursor> {
  const raw = await SecureStore.getItemAsync(cursorKey(userId));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as HealthCursor;
      if (parsed.startAt && parsed.anchors) return parsed;
    } catch { /* Begin a safe seven-day synchronization below. */ }
  }
  return { startAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), anchors: {} };
}

export async function syncAppleHealth(api: Api, userId: string) {
  if (Platform.OS !== 'ios' || !isHealthDataAvailable()) throw new Error('Apple Health is available only in the installed iPhone app.');
  await requestAuthorization({ toRead: observedTypes });
  const cursor = await loadCursor(userId);
  const startDate = new Date(cursor.startAt);
  const nextAnchors: Record<string, string> = {};
  const samples: HealthSampleInput[] = [];

  for (const item of quantities) {
    const result = await queryQuantitySamplesWithAnchor(item.id, {
      filter: { date: { startDate, strictStartDate: true } },
      limit: 0,
      unit: item.unit,
      ...(cursor.anchors[item.id] ? { anchor: cursor.anchors[item.id] } : {}),
    });
    nextAnchors[item.id] = result.newAnchor;
    samples.push(...result.samples.filter(sample => Number.isFinite(sample.quantity) && sample.quantity > 0).map(sample => ({
      source_id: sample.uuid,
      metric: item.metric,
      start_at: sample.startDate.toISOString(),
      end_at: sample.endDate.toISOString(),
      value: sample.quantity,
    })));
  }

  const workoutResult = await queryWorkoutSamplesWithAnchor({
    filter: { date: { startDate, strictStartDate: true } },
    limit: 0,
    ...(cursor.anchors[WorkoutTypeIdentifier] ? { anchor: cursor.anchors[WorkoutTypeIdentifier] } : {}),
  });
  nextAnchors[WorkoutTypeIdentifier] = workoutResult.newAnchor;
  const workouts: WorkoutInput[] = [];
  for (const workout of workoutResult.workouts) {
    if (Number.isFinite(workout.duration.quantity) && workout.duration.quantity > 0) {
      workouts.push({
        source_id: workout.uuid,
        activity_type: String(workout.workoutActivityType),
        start_at: workout.startDate.toISOString(),
        end_at: workout.endDate.toISOString(),
        duration_seconds: workout.duration.quantity,
        ...(workout.totalEnergyBurned && Number.isFinite(workout.totalEnergyBurned.quantity) && workout.totalEnergyBurned.quantity > 0
          ? { energy_kcal: workout.totalEnergyBurned.quantity } : {}),
      });
    }
    workout.dispose();
  }

  let accepted = 0;
  let sampleIndex = 0;
  let workoutIndex = 0;
  while (sampleIndex < samples.length || workoutIndex < workouts.length) {
    const response = await api.syncHealthData({
      samples: samples.slice(sampleIndex, sampleIndex + 750),
      workouts: workouts.slice(workoutIndex, workoutIndex + 200),
    });
    accepted += response.accepted;
    sampleIndex += 750;
    workoutIndex += 200;
  }
  if (!samples.length && !workouts.length) await api.syncHealthData({ samples: [], workouts: [] });

  // Commit anchors only after every AWS upload succeeds. Failed uploads are
  // retried and DynamoDB's deterministic keys safely overwrite duplicates.
  await SecureStore.setItemAsync(cursorKey(userId), JSON.stringify({ ...cursor, anchors: nextAnchors }));
  return { accepted };
}

export async function enableAppleHealthBackgroundSync(onChange: () => void) {
  if (Platform.OS !== 'ios' || !isHealthDataAvailable()) return () => {};
  await requestAuthorization({ toRead: observedTypes });
  await configureBackgroundTypes(observedTypes, UpdateFrequency.immediate);
  const subscriptions = observedTypes.map(identifier => subscribeToChanges(identifier, ({ errorMessage }) => {
    if (!errorMessage) onChange();
  }));
  return () => subscriptions.forEach(subscription => subscription.remove());
}

export async function disableAppleHealthBackgroundSync() {
  if (Platform.OS === 'ios' && isHealthDataAvailable()) await clearBackgroundTypes();
}
