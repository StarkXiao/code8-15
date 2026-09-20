import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  havDistance, bearing, destination, locateOnRunway,
  runwayToLatLon, fmtStation, parseStation,
} from '../server/geo.js';

const PVG = { lat: 31.1946, lon: 121.8352 };
const B = 156;

test('havDistance 与基准值一致（浦东附近 1km 量级）', () => {
  const p = destination(PVG, B, 1000);
  const d = havDistance(PVG, p);
  assert.ok(Math.abs(d - 1000) < 0.01);
});

test('正算再反算：沿跑道走 1234.5m、右偏 8m 能还原', () => {
  const p = runwayToLatLon(PVG, B, 1234.5, 8);
  const loc = locateOnRunway(PVG, B, p);
  assert.ok(Math.abs(loc.station - 1234.5) < 0.05, `station=${loc.station}`);
  assert.ok(Math.abs(loc.offset - 8) < 0.05, `offset=${loc.offset}`);
});

test('横距符号：面向跑道方向，右侧为正、左侧为负', () => {
  const right = runwayToLatLon(PVG, B, 500, 5);
  const left = runwayToLatLon(PVG, B, 500, -5);
  assert.ok(locateOnRunway(PVG, B, right).offset > 4.9);
  assert.ok(locateOnRunway(PVG, B, left).offset < -4.9);
});

test('阈值点本身：里程 0、横距 0', () => {
  const loc = locateOnRunway(PVG, B, PVG);
  assert.equal(loc.station, 0);
  assert.equal(loc.offset, 0);
});

test('里程格式化与解析互逆', () => {
  assert.equal(fmtStation(1234.56), 'K1+234.56');
  assert.equal(fmtStation(42.1), 'K0+042.10');
  assert.equal(fmtStation(-50), '-K0+050.00');
  for (const v of [0, 1, 999.99, 1000, 3800.0, -12.5]) {
    assert.ok(Math.abs(parseStation(fmtStation(v)) - v) < 0.001);
  }
  assert.equal(parseStation('K1+234.56'), 1234.56);
  assert.equal(parseStation('1234.5'), 1234.5);
  assert.equal(parseStation('abc'), null);
});
