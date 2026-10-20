import { soundUnits } from './sounds';

const texts = (word: string) =>
  soundUnits(
    word,
    [...word].map(() => 1),
  ).map((unit) => unit.text);

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
    const units = soundUnits('things', [0.028, 0.015, 0.974, 0.974, 0.001, 0.986]);
    expect(units.map((unit) => unit.level)).toEqual(['bad', 'good', 'good', 'good']);
    expect(units[0].score).toBeCloseTo(0.028);
  });

  it('has no level without scores', () => {
    expect(soundUnits('it', []).map((unit) => unit.level)).toEqual(['none', 'none']);
  });
});
