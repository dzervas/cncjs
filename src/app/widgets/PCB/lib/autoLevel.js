import log from 'app/lib/log';
import {
    IMPERIAL_UNITS,
    METRIC_UNITS,
} from 'app/constants';
// Code got from https://github.com/kreso-t/cncjs-kt-ext

function generateAutolevelGcode(bbox, margin, delta, zSafe, feedrate) {
    log.info('Starting autoleveling');

    let plannedPointCount = 0;
    // TODO: Check for undefined and faulty numbers

    let code = [];
    let xmin = bbox.min.x - margin;
    let xmax = bbox.max.x + margin;
    let ymin = bbox.min.y - margin;
    let ymax = bbox.max.y + margin;

    let dx = (xmax - xmin) / parseInt((xmax - xmin) / delta, 10);
    let dy = (ymax - ymin) / parseInt((ymax - ymin) / delta, 10);
    // TODO: Use the `controller` to send motion/whatever commands
    // like the Probe widget:
    // https://github.com/cncjs/cncjs/blob/6f2ec1574eace3c99b4a18c3de199b222524d0e1/src/app/widgets/Probe/index.jsx#L132
    code.push('G21');
    code.push('G90');
    code.push(`G0 X${xmin.toFixed(3)} Y${ymin.toFixed(3)}`);
    // TODO: Set specific max depth
    code.push(`G38.2 Z-${zSafe + 1} F${feedrate / 2}`);
    code.push('G10 L20 P1 Z0'); // set the z zero
    code.push(`G0 Z${zSafe}`);
    plannedPointCount++;

    let y = ymin - dy;

    while (y < ymax - 0.01) {
        y += dy;
        if (y > ymax) {
            y = ymax;
        }

        let x = xmin - dx;
        if (y <= ymin + 0.01) {
            // Don't probe first point twice
            x = xmin;
        }

        while (x < xmax - 0.01) {
            x += dx;
            if (x > xmax) {
                x = xmax;
            }
            code.push(`G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)} Z${zSafe}`);
            code.push(`G38.2 Z-${zSafe + 1} F${feedrate}`);
            code.push(`G0 Z${zSafe}`);
            plannedPointCount++;
        }
    }

    log.info(`Sending GCode:\n${code.join('\n')}\n`);

    return { plannedPointCount, code };
}

function applyCompensation(gcode, probedPoints, delta) {
    log.info('Applying compensation');

    let lines = gcode.split('\n');
    let p0 = {
        x: 0,
        y: 0,
        z: 0
    };
    let p0Initialized = false;
    let pt = {
        x: 0,
        y: 0,
        z: 0
    };

    let abs = true;
    let units = METRIC_UNITS;
    let result = [];
    lines.forEach(line => {
        let lineStripped = stripComments(line);
        if (/(G38.+|G5.+|G10|G4.+|G92|G92.1)/gi.test(lineStripped)) {
            // Skip compensation for these G-Codes
            result.push(lineStripped);
        } else {
            if (/G91/i.test(lineStripped)) {
                abs = false;
            }
            if (/G90/i.test(lineStripped)) {
                abs = true;
            }
            if (/G20/i.test(lineStripped)) {
                units = IMPERIAL_UNITS;
            }
            if (/G21/i.test(lineStripped)) {
                units = METRIC_UNITS;
            }

            if (!/(X|Y|Z)/gi.test(lineStripped)) {
                result.push(lineStripped); // No coordinate change --> copy to output
            } else {
                let xMatch = /X([\.\+\-\d]+)/gi.exec(lineStripped);
                if (xMatch) {
                    pt.x = parseFloat(xMatch[1]);
                }

                let yMatch = /Y([\.\+\-\d]+)/gi.exec(lineStripped);
                if (yMatch) {
                    pt.y = parseFloat(yMatch[1]);
                }

                let zMatch = /Z([\.\+\-\d]+)/gi.exec(lineStripped);
                if (zMatch) {
                    pt.z = parseFloat(zMatch[1]);
                }

                if (abs) {
                    // Strip coordinates
                    lineStripped = lineStripped.replace(/([XYZ])([\.\+\-\d]+)/gi, '');
                    if (p0Initialized) {
                        let segs = splitToSegments(p0, pt, delta);
                        for (let seg of segs) {
                            let cpt = compensateZCoord(seg, units, probedPoints);
                            let newLine = lineStripped + ` X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)} ; Z${seg.z.toFixed(3)}`;
                            result.push(newLine.trim());
                        }
                    } else {
                        let cpt = compensateZCoord(pt, units, probedPoints);
                        let newLine = lineStripped + ` X${cpt.x.toFixed(3)} Y${cpt.y.toFixed(3)} Z${cpt.z.toFixed(3)} ; Z${pt.z.toFixed(3)}`;
                        result.push(newLine.trim());
                        p0Initialized = true;
                    }
                } else {
                    result.push(lineStripped);
                    log.warn('Using relative mode may not produce correct results');
                }
                p0 = {
                    x: pt.x,
                    y: pt.y,
                    z: pt.z
                }; // Clone
            }
        }
    });

    log.debug(result.join('\n'));
    return result.join('\n');
}

function stripComments(line) {
    const re1 = new RegExp(/\s*\([^\)]*\)/g); // Remove anything inside the parentheses
    const re2 = new RegExp(/\s*;.*/g); // Remove anything after a semi-colon to the end of the line, including preceding spaces
    const re3 = new RegExp(/\s+/g);
    return (line.replace(re1, '').replace(re2, '').replace(re3, ''));
}

function distanceSquared3(p1, p2) {
    return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y) + (p2.z - p1.z) * (p2.z - p1.z);
}

function distanceSquared2(p1, p2) {
    return (p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y);
}

function crossProduct3(u, v) {
    return {
        x: (u.y * v.z - u.z * v.y),
        y: -(u.x * v.z - u.z * v.x),
        z: (u.x * v.y - u.y * v.x)
    };
}

function isColinear(u, v) {
    return Math.abs(u.x * v.y - u.y * v.x) < 0.00001;
}

function sub3(p1, p2) {
    return {
        x: p1.x - p2.x,
        y: p1.y - p2.y,
        z: p1.z - p2.z
    };
}

function formatPt(pt) {
    return `(x:${pt.x.toFixed(3)} y:${pt.y.toFixed(3)} z:${pt.z.toFixed(3)})`;
}

function splitToSegments(p1, p2, units, delta) {
    let res = [];
    let v = sub3(p2, p1); // Delta
    let dist = Math.sqrt(distanceSquared3(p1, p2)); // Distance
    let dir = {
        x: v.x / dist,
        y: v.y / dist,
        z: v.z / dist
    }; // Direction vector
    let maxSegLength = convertUnits(delta, METRIC_UNITS, units) / 2;
    res.push({
        x: p1.x,
        y: p1.y,
        z: p1.z
    }); // First point
    for (let d = maxSegLength; d < dist; d += maxSegLength) {
        res.push({
            x: p1.x + dir.x * d,
            y: p1.y + dir.y * d,
            z: p1.z + dir.z * d
        }); // Split points
    }
    res.push({
        x: p2.x,
        y: p2.y,
        z: p2.z
    }); // Last point
    return res;
}

// Argument is assumed to be in millimeters.
function getThreeClosestPoints(pt, probedPoints) {
    let res = [];
    if (probedPoints.length < 3) {
        return res;
    }
    probedPoints.sort((a, b) => {
        return distanceSquared2(a, pt) < distanceSquared2(b, pt) ? -1 : 1;
    });
    let i = 0;
    while (res.length < 3 && i < probedPoints.length) {
        if (res.length === 2) {
            // Make sure points are not colinear
            if (!isColinear(sub3(res[1], res[0]), sub3(probedPoints[i], res[0]))) {
                res.push(probedPoints[i]);
            }
        } else {
            res.push(probedPoints[i]);
        }

        i++;
    }
    return res;
}

function compensateZCoord(PtInOrMM, inputUnits, probedPoints) {
    let ptMM = {
        x: convertUnits(PtInOrMM.x, inputUnits, METRIC_UNITS),
        y: convertUnits(PtInOrMM.y, inputUnits, METRIC_UNITS),
        z: convertUnits(PtInOrMM.z, inputUnits, METRIC_UNITS)
    };

    let points = getThreeClosestPoints(ptMM, probedPoints);
    if (points.length < 3) {
        log.error('Cant find 3 closest points');
        return PtInOrMM;
    }

    let normal = crossProduct3(sub3(points[1], points[0]), sub3(points[2], points[0]));
    let pp = points[0]; // Point on plane
    let dz = 0; // Compensation delta

    if (normal.z !== 0) {
        // Find z at the point seg, on the plane defined by three points
        dz = pp.z - (normal.x * (ptMM.x - pp.x) + normal.y * (ptMM.y - pp.y)) / normal.z;
    } else {
        log.warn(formatPt(ptMM), 'normal.z is zero', formatPt(points[0]), formatPt(points[1]), formatPt(points[2]));
    }

    return {
        x: convertUnits(ptMM.x, METRIC_UNITS, inputUnits),
        y: convertUnits(ptMM.y, METRIC_UNITS, inputUnits),
        z: convertUnits(ptMM.z + dz, METRIC_UNITS, inputUnits)
    };
}

function convertUnits(value, inUnits, outUnits) {
    if (inUnits === METRIC_UNITS && outUnits === IMPERIAL_UNITS) {
        return value / 25.4;
    }
    if (inUnits === IMPERIAL_UNITS && outUnits === METRIC_UNITS) {
        return value * 25.4;
    }

    return value;
}

export { generateAutolevelGcode, applyCompensation };
