import { Platform } from 'react-native';
import {
  isHealthDataAvailable,
  queryQuantitySamples,
  queryWorkoutSamples,
  requestAuthorization,
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

export async function syncAppleHealth(api: Api) {
  if (Platform.OS !== 'ios' || !isHealthDataAvailable()) throw new Error('Apple Health is available only in the installed iPhone app.');
  await requestAuthorization({ toRead: [...quantities.map(item => item.id), WorkoutTypeIdentifier] });
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const samples: HealthSampleInput[] = [];
  for (const item of quantities) {
    const found = await queryQuantitySamples(item.id, {
      filter: { date: { startDate, strictStartDate: true } }, limit: 0, ascending: true, unit: item.unit,
    });
    samples.push(...found.filter(sample => Number.isFinite(sample.quantity) && sample.quantity > 0).map(sample => ({
      source_id: sample.uuid, metric: item.metric,
      start_at: sample.startDate.toISOString(), end_at: sample.endDate.toISOString(), value: sample.quantity,
    })));
  }
  const workoutSamples = await queryWorkoutSamples({ filter: { date: { startDate, strictStartDate: true } }, limit: 0, ascending: true });
  const workouts: WorkoutInput[] = workoutSamples.filter(workout => Number.isFinite(workout.duration.quantity) && workout.duration.quantity > 0).map(workout => ({
    source_id: workout.uuid, activity_type: String(workout.workoutActivityType),
    start_at: workout.startDate.toISOString(), end_at: workout.endDate.toISOString(),
    duration_seconds: workout.duration.quantity,
    ...(workout.totalEnergyBurned && Number.isFinite(workout.totalEnergyBurned.quantity) && workout.totalEnergyBurned.quantity > 0
      ? { energy_kcal: workout.totalEnergyBurned.quantity } : {}),
  }));
  let accepted = 0;
  let sampleIndex = 0, workoutIndex = 0;
  while (sampleIndex < samples.length || workoutIndex < workouts.length) {
    const response = await api.syncHealthData({ samples: samples.slice(sampleIndex, sampleIndex + 750), workouts: workouts.slice(workoutIndex, workoutIndex + 200) });
    accepted += response.accepted;
    sampleIndex += 750; workoutIndex += 200;
  }
  if (!samples.length && !workouts.length) {
    await api.syncHealthData({ samples: [], workouts: [] });
    return { accepted: 0 };
  }
  return { accepted };
}
