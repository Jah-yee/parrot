import { soundUnits } from './sounds';

const texts = (w: string) => soundUnits(w, [...w].map(() => 1)).map((u) => u.text);

describe('soundUnits', () => {
  it('groups letters that spell one sound', () => {
    expect(texts('night')).toEqual(['n', 'igh', 't']);
    expect(texts('things')).toEqual(['th', 'i', 'ng', 's']);
    expect(texts('need')).toEqual(['n', 'ee', 'd']);
    expect(texts('Parrot')).toEqual(['P', 'a', 'rr', 'o', 't']);
    expect(texts('paste')).toEqual(['p', 'a', 's', 'te']);
    expect(texts('say')).toEqual(['s', 'ay']);
    expect(texts('you')).toEqual(['y', 'ou']);
  });

  it('leaves out punctuation', () => {
    expect(texts('loud.')).toEqual(['l', 'ou', 'd']);
  });

  it('scores a unit by its best letter', () => {
    // "things" said as "sinks": th low, ng fine though the model gave the sound to the n
    const u = soundUnits('things', [0.028, 0.015, 0.974, 0.974, 0.001, 0.986]);
    expect(u.map((x) => x.level)).toEqual(['bad', 'good', 'good', 'good']);
    expect(u[0].score).toBeCloseTo(0.028);
  });

  it('has no level without scores', () => {
    expect(soundUnits('it', []).map((u) => u.level)).toEqual(['none', 'none']);
  });
});
