import { DemandRow, estimateQualificationNeed, qualificationKey } from './qualification-need';

const d = (provincePsgc: string, qualification: string, graduates: number): DemandRow => ({ provincePsgc, qualification, graduates });
const none = () => 0;

describe('qualificationKey', () => {
  it('treats "NC" spellings and case as the same qualification', () => {
    expect(qualificationKey('DRIVING NC II')).toBe('driving ii');
    expect(qualificationKey('Driving II')).toBe('driving ii');
    expect(qualificationKey('Shielded Metal Arc Welding (SMAW) II')).toBe(qualificationKey('SHIELDED METAL ARC WELDING (SMAW) NC II'));
  });
});

describe('estimateQualificationNeed', () => {
  const demand = [d('P1', 'Driving II', 600), d('P1', 'Cookery II', 300), d('P1', 'Welding II', 100), d('P2', 'Cookery II', 50), d('P2', 'Caregiving II', 150)];

  it('splits the candidates served over the province mix and ranks the biggest first', () => {
    const r = estimateQualificationNeed([{ provincePsgc: 'P1', count: 1000 }], demand, none);
    expect(r.map((x) => [x.qualification, x.estimatedCandidates])).toEqual([['Driving II', 600], ['Cookery II', 300], ['Welding II', 100]]);
    expect(r[0]!.share).toBeCloseTo(0.6, 5);
    expect(r.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1, 5);
  });

  it('adds up over several provinces in proportion to the candidates served in each', () => {
    const r = estimateQualificationNeed([{ provincePsgc: 'P1', count: 100 }, { provincePsgc: 'P2', count: 400 }], demand, none, 4);
    // Cookery: 100 x 0.3 + 400 x 0.25 = 130; Caregiving: 400 x 0.75 = 300; Driving: 100 x 0.6 = 60
    expect(r.map((x) => [x.qualification, x.estimatedCandidates])).toEqual([['Caregiving II', 300], ['Cookery II', 130], ['Driving II', 60], ['Welding II', 10]]);
  });

  it('keeps only the top few', () => {
    expect(estimateQualificationNeed([{ provincePsgc: 'P1', count: 10 }], demand, none, 2)).toHaveLength(2);
  });

  it('leaves a province with no graduate data out of the shares, and says nothing when none has data', () => {
    const r = estimateQualificationNeed([{ provincePsgc: 'P1', count: 100 }, { provincePsgc: 'NODATA', count: 900 }], demand, none);
    expect(r[0]!.share).toBeCloseTo(0.6, 5); // shares are of the 100 candidates that have data
    expect(estimateQualificationNeed([{ provincePsgc: 'NODATA', count: 50 }], demand, none)).toEqual([]);
    expect(estimateQualificationNeed([], demand, none)).toEqual([]);
  });

  it('reports how many centers already offer each, asking for the provinces served', () => {
    const asked: Array<[string[], string]> = [];
    const r = estimateQualificationNeed([{ provincePsgc: 'P1', count: 10 }, { provincePsgc: 'P2', count: 10 }], demand, (provs, name) => {
      asked.push([[...provs].sort(), name]);
      return name === 'Driving II' ? 0 : 4;
    });
    expect(asked[0]![0]).toEqual(['P1', 'P2']);
    expect(Object.fromEntries(r.map((x) => [x.qualification, x.centersOffering]))['Driving II']).toBe(0);
  });

  it('matches by name, so two spellings of one qualification count once', () => {
    const rows = [d('P1', 'Barista II', 30), d('P1', 'BARISTA NC II', 30), d('P1', 'Cookery II', 40)];
    const r = estimateQualificationNeed([{ provincePsgc: 'P1', count: 100 }], rows, none);
    expect(r.map((x) => [x.qualification, x.estimatedCandidates])).toEqual([['Barista II', 60], ['Cookery II', 40]]);
  });

  it('breaks a tie by the one fewer centers offer', () => {
    const tie = [d('P', 'A II', 100), d('P', 'B II', 100)];
    const r = estimateQualificationNeed([{ provincePsgc: 'P', count: 10 }], tie, (_p, name) => (name === 'A II' ? 5 : 1));
    expect(r.map((x) => x.qualification)).toEqual(['B II', 'A II']);
  });
});
