import { describe, expect, it } from 'vitest';
import { formatDimension, formatDimensionForUnit } from './dimensions';

describe('dimension formatting', () => {
  it('never exposes a numeric value for an unknown dimension', () => {
    expect(formatDimension({
      value_m: null,
      status: 'unknown',
      estimated: false,
      source_id: null,
      confidence: 'unknown'
    })).toEqual({ text: '—', badge: 'unknown', approximate: true });
  });

  it('surfaces quantified visualization uncertainty in metric and imperial units', () => {
    const dimension = {
      value_m: 4.115,
      uncertainty_m: 0.3048,
      status: 'estimated' as const,
      estimated: true,
      source_id: 'model-source',
      confidence: 'medium' as const
    };

    expect(formatDimensionForUnit(dimension, 'metric').text).toBe('~4.115 m ± 0.305 m');
    expect(formatDimensionForUnit(dimension, 'imperial').text).toBe('~13 ft 6 in ± 1 ft');
  });

  it('leaves verified dimensions unqualified', () => {
    expect(formatDimensionForUnit({
      value_m: 1,
      status: 'verified',
      estimated: false,
      source_id: 'verified-source',
      confidence: 'high'
    }, 'metric').text).toBe('1 m');
  });
});
