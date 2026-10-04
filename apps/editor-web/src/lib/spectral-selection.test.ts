import { expect, it } from "vitest";
import { spectralMask, spectralPoint } from "./spectral-selection";

it("maps visible CSS geometry to clamped document frames and linear frequency", () => {
  expect(spectralPoint(50, 25, 100, 100, { start: 1000, end: 2000 }, 5000, 48000)).toEqual({
    frame: 1500,
    hz: 18000,
  });
  expect(spectralPoint(-20, 150, 100, 100, { start: -1000, end: 2000 }, 5000, 48000)).toEqual({
    frame: 0,
    hz: 0,
  });
  expect(spectralPoint(150, -10, 100, 100, { start: 4000, end: 6000 }, 5000, 48000)).toEqual({
    frame: 5000,
    hz: 24000,
  });
});
it("bounds reverse rectangles and retains independent bounded lasso vertices", () => {
  const points = [
    { frame: 100.8, hz: 400 },
    { frame: 20.2, hz: 100 },
  ];
  expect(spectralMask(points, "rectangle", 1000)).toEqual({
    start: 20,
    end: 101,
    lowHz: 100,
    highHz: 400,
  });
  expect(spectralMask(points, "lasso", 1000)).toBeUndefined();
  points.push({ frame: 60, hz: 300 });
  const polygon = spectralMask(points, "lasso", 1000);
  expect(polygon?.points).toEqual(points);
  points[0].hz = 0;
  expect(polygon?.points?.[0]?.hz).toBe(400);
  expect(
    spectralMask(
      [
        { frame: 20, hz: 100 },
        { frame: 20, hz: 200 },
      ],
      "rectangle",
      1000,
    ),
  ).toBeUndefined();
  expect(
    spectralMask(
      [
        { frame: 20, hz: 100 },
        { frame: 40, hz: NaN },
      ],
      "rectangle",
      1000,
    ),
  ).toBeUndefined();
});
