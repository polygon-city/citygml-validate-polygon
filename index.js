// Validate a CityGML Polygon against QIE spec
// See: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/blob/master/errors/errors.md#polygon

// TODO: Test against a CityGML dataset containing valid and invalid geometry
// TODO: Implement test for GE_P_INTERIOR_DISCONNECTED

var _ = require("lodash");
var async = require("async");
var sylvester = require("sylvester");
var Vec2 = require("vec2");
var polygonjs = require("polygon");

// Custom modules
var citygmlBoundaries = require("citygml-boundaries");
var citygmlPoints = require("citygml-points");
var points3dto2d = require("points-3d-to-2d");
var triangulate = require("triangulate");

var citygmlValidatePolygon = function(polygonXML, callback) {
  // Get exterior and interior boundaries for polygon (outer and holes)
  var rings = citygmlBoundaries(polygonXML);

  // Validate polygon
  // Validation errors are stored within results array
  async.series([
    GE_P_INTERSECTION_RINGS(rings),
    GE_P_DUPLICATED_RINGS(rings),
    GE_P_NON_PLANAR_POLYGON_DISTANCE_PLANE(rings),
    GE_P_NON_PLANAR_POLYGON_NORMALS_DEVIATION(rings),
    // GE_P_INTERIOR_DISCONNECTED(rings)
    GE_P_HOLE_OUTSIDE(rings),
    GE_P_INNER_RINGS_NESTED(rings),
    GE_P_ORIENTATION_RINGS_SAME(rings)
  ], function(err, results) {
    callback(err, results);
  });
};

var GE_P_INTERSECTION_RINGS = function(rings) {
  // Two or more rings intersect, these can be either the exterior ring with an
  // interior ring or only interior rings.
  //
  // Example: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/raw/master/errors/figs/201.png

  // Async pattern as per Pro JavaScript Frameworks book
  // Missing process.nextTick trick inside the function
  return function(callback) {
    var exteriorPoints = citygmlPoints(rings.exterior[0]);
    var exteriorPoints2d = points3dto2d(exteriorPoints);
    var exteriorPolygon = polygonjs(exteriorPoints2d.points);

    var interiors = rings.interior;
    var interiorPoint2ds = [];

    // Pass immediately if no interior rings
    if (!interiors || interiors.length === 0) {
      callback(null);
      return;
    }

    var intersections = [];

    _.each(interiors, function(interiorXML) {
      var interiorPoints = citygmlPoints(interiorXML);

      // Pass in external polygon origin for 2D coordinates
      var interiorPoints2d = points3dto2d(interiorPoints, false, exteriorPoints2d.state);

      interiorPoint2ds.push(interiorPoints2d.points);

      var result;
      var lastResult;
      var intersection = false;

      // Check exteriorPolygon.containsPoint() on each point
      // - If a mix of true and false then rings intersect
      _.each(interiorPoints2d.points, function(point) {
        result = exteriorPolygon.containsPoint(new Vec2(point));

        if (lastResult !== undefined && lastResult != result) {
          intersection = true;
        }

        lastResult = result;
      });

      if (intersection) {
        intersections.push([exteriorPoints2d.points, interiorPoints2d.points]);
      }
    });

    var checkRingPolygon;

    // Check intersections between interior rings
    while (interiorPoint2ds.length > 0) {
      checkRingPoints2d = interiorPoint2ds.shift();
      checkRingPolygon = polygonjs(checkRingPoints2d);

      _.each(interiorPoint2ds, function(ringPoints2d) {
        var result;
        var lastResult;
        var intersection = false;

        _.each(ringPoints2d, function(point) {
          result = checkRingPolygon.containsPoint(new Vec2(point));

          if (lastResult !== undefined && lastResult != result) {
            intersection = true;
          }

          lastResult = result;
        });

        if (intersection) {
          intersections.push([checkRingPoints2d, ringPoints2d]);
        }
      });
    };

    if (intersections.length === 0) {
      callback(null);
    } else {
      callback(null, [new Error("GE_P_INTERSECTION_RINGS: Two or more rings intersect"), intersections]);
    }
  };
};

// TODO: Do a test on 3D coordinates as converting to 2D could cause issues
var GE_P_DUPLICATED_RINGS = function(rings) {
  // Two or more rings are identical.

  return function(callback) {
    var checkRings = rings.exterior.concat(rings.interior);

    var checkRingXML;
    var checkRingPoints;
    var checkRingPoints2d;
    var checkRingPolygon;

    var ringPoints;
    var ringPoints2d;
    var ringPolygon;

    var duplicatedRings = [];
    var points2dState;

    while (checkRings.length > 0) {
      checkRingXML = checkRings.shift();
      checkRingPoints = citygmlPoints(checkRingXML);

      checkRingPoints2d = points3dto2d(checkRingPoints, false, points2dState);

      if (!points2dState) {
        points2dState = checkRingPoints2d.state;
      }

      checkRingPolygon = polygonjs(checkRingPoints2d.points);

      _.each(checkRings, function(ringXML) {
        ringPoints = citygmlPoints(ringXML);
        ringPoints2d = points3dto2d(ringPoints, false, points2dState);
        ringPolygon = polygonjs(ringPoints2d.points);

        if (checkRingPolygon.equal(ringPolygon)) {
          duplicatedRings.push([checkRingPoints2d.points, ringPoints2d.points]);
        }
      });
    }

    if (duplicatedRings.length === 0) {
      callback(null);
    } else {
      callback(null, [new Error("GE_P_DUPLICATED_RINGS: Two or more rings are identical"), duplicatedRings]);
    }
  };
};

// Based on: https://github.com/mrdoob/three.js/blob/master/src/math/Plane.js
// TODO: Use least-square adjustment for plane
// See: http://threejs.org/docs/#Reference/Math/Plane
// See: http://www.songho.ca/math/plane/plane.html
// See: http://stackoverflow.com/questions/1400213/3d-least-squares-plane
// See: https://github.com/Tom-Alexander/regression-js
var GE_P_NON_PLANAR_POLYGON_DISTANCE_PLANE = function(rings) {
  // A polygon must be planar, ie all its points (used for both the exterior and
  // interior rings) must lie on a plane. To verify this, we must ensure that
  // the the distance between every point and a plane is less than
  // $$\epsilon_1$$, a given tolerance (eg 1cm). This plane should be a plane
  // fitted with least-square adjustment.

  return function(callback) {
    // TODO: Should be abstracted into a Plane module as it's also used in
    // GE_S_SELF_INTERSECTION
    var plane = {
      normal: undefined,
      constant: undefined
    };

    var exteriorPoints = citygmlPoints(rings.exterior[0]);

    // Describe plane
    plane.normal = $V(normalUnit(exteriorPoints[0], exteriorPoints[1], exteriorPoints[2]));
    plane.constant = - $V(exteriorPoints[0]).dot(plane.normal);

    // In metres (so 1mm)
    var distanceTolerance = 0.001;
    var distance;

    var nonPlanars = [];

    var checkRings = rings.exterior.concat(rings.interior);
    var checkRingXML;
    var checkRingPoints;

    _.each(checkRings, function(checkRingXML) {
      checkRingPoints = citygmlPoints(checkRingXML);

      _.each(checkRingPoints, function(point) {
        // Distance from point to plane
        distance = Math.abs(plane.normal.dot(point) + plane.constant);

        if (distance > distanceTolerance) {
          nonPlanars.push([point, distance]);
        }
      });
    });

    if (nonPlanars.length === 0) {
      callback(null);
    } else {
      callback(null, [new Error("GE_P_NON_PLANAR_POLYGON_DISTANCE_PLANE: A polygon must be planar"), nonPlanars]);
    }
  };
};

// TODO: Triangulate polygon with holes
var GE_P_NON_PLANAR_POLYGON_NORMALS_DEVIATION = function(rings) {
  // To ensure that cases such as that below are detected (the top polygon is
  // clearly non-planar, but would not be detected with 203 and a tolerance of
  // 1cm for instance), another requirement is necessary: the distance between
  // every point forming a polygon and all the planes defined by all possible
  // combinations of 3 non-colinear points is less than $$\epsilon_1$$. In
  // practice it can be implemented with a triangulation of the polygon (any
  // triangulation): the orientation of the normal of each triangle must not
  // deviate more than a certain user-defined tolerance $$\epsilon_2$$ (eg
  // 1 degree).
  //
  // Example: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/raw/master/errors/figs/204.png

  return function(callback) {
    var checkRings = rings.exterior.concat(rings.interior);
    var checkRingXML;
    var checkRingPoints;

    var nonPlanars = [];

    _.each(checkRings, function(checkRingXML) {
      checkRingPoints = citygmlPoints(checkRingXML);

      // Triangulate polygon
      var faces;

      try {
        faces = triangulate(checkRingPoints);
      } catch(err) {
        callback(null, [new Error("GE_P_NON_PLANAR_POLYGON_NORMALS_DEVIATION: Unable to triangulate polygon"), checkRingPoints]);
        return;
      }

      var faceNormal;

      var checkNormal;
      var normalAngle;

      // Normal angle tolerance in degrees
      var angleTolerance = 1;
      var nonPlanar = false;

      _.each(faces, function(face, index) {
        // Get face normal
        faceNormal = normalUnit(checkRingPoints[face[0]], checkRingPoints[face[1]], checkRingPoints[face[2]]);

        if (!checkNormal) {
          checkNormal = $V(faceNormal);
          return;
        }

        normalAngle = checkNormal.angleFrom($V(faceNormal)) * 180 / Math.PI;

        if (Math.abs(normalAngle) > angleTolerance) {
          nonPlanar = true;
        }
      });

      if (nonPlanar) {
        nonPlanars.push(checkRingPoints);
      }
    });

    if (nonPlanars.length === 0) {
      callback(null);
    } else {
      callback(null, [new Error("GE_P_NON_PLANAR_POLYGON_NORMALS_DEVIATION: The orientation of the normal of each triangle must not deviate more than 1 degree"), nonPlanars]);
    }
  };
};

// Basic premise is to ensure that interior polygons don't cut the exterior into
// multiple parts. Could perform polygonjs.cut() and look for multiple results.
var GE_P_INTERIOR_DISCONNECTED = function(rings) {
  // The interior of a polygon must be connected.
  //
  // Example: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/raw/master/errors/figs/205.png

  return function(callback) {
    callback(null);
  };
};

// TODO: Double-check this doesn't fail when an inner polygon is touching the
// outer edge of the exterior polygon
var GE_P_HOLE_OUTSIDE = function(rings) {
  // One or more interior ring(s) is(are) located completely outside the
  // exterior ring. If the interior ring intersects the exterior ring, then
  // error GE_P_INTERSECTION_RINGS should be returned.
  //
  // Example: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/raw/master/errors/figs/206.png

  return function(callback) {
    var exteriorPoints = citygmlPoints(rings.exterior[0]);
    var exteriorPoints2d = points3dto2d(exteriorPoints, false);
    var exteriorPolygon = polygonjs(exteriorPoints2d.points);

    var interiors = rings.interior;

    // Pass immediately if no interior rings
    if (!interiors || interiors.length === 0) {
      callback(null);
      return;
    }

    var outsides = [];

    _.each(interiors, function(interiorXML) {
      var interiorPoints = citygmlPoints(interiorXML);

      // Pass in external polygon origin for 2D coordinates
      var interiorPoints2d = points3dto2d(interiorPoints, false, exteriorPoints2d.state);

      var result;
      var outside = true;

      _.each(interiorPoints2d.points, function(point) {
        result = exteriorPolygon.containsPoint(new Vec2(point));

        if (result) {
          outside = false;
        }
      });

      if (outside) {
        outsides.push([exteriorPoints2d.points, interiorPoints2d.points]);
      }

      if (outsides.length === 0) {
        callback(null);
      } else {
        callback(null, [new Error("GE_P_HOLE_OUTSIDE: One or more interior rings are located completely outside the exterior ring"), outsides]);
      }
    });
  };
};

var GE_P_INNER_RINGS_NESTED = function(rings) {
  // One or more interior ring(s) is(are) located completely inside another interior ring.
  //
  // Example: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/raw/master/errors/figs/207.png

  return function(callback) {
    var interiors = _.clone(rings.interior);

    // Pass immediately if no interior rings
    if (!interiors || interiors.length === 0) {
      callback(null);
      return;
    }

    var insides = [];

    // Check intersections between interior rings
    while (interiors.length > 0) {
      var checkXML = interiors.shift();
      var checkPoints = citygmlPoints(checkXML);
      var checkPoints2d = points3dto2d(checkPoints);
      var checkPolygon = polygonjs(checkPoints2d.points);

      _.each(interiors, function(interiorXML) {
        var interiorPoints = citygmlPoints(interiorXML);

        // Pass in external polygon origin for 2D coordinates
        var interiorPoints2d = points3dto2d(interiorPoints, false, checkPoints2d.state);

        var result;
        var nested = true;

        _.each(interiorPoints2d.points, function(point) {
          result = checkPolygon.containsPoint(new Vec2(point));

          if (!result) {
            nested = false;
          }
        });

        if (nested) {
          insides.push([checkPoints2d.points, interiorPoints2d.points]);
        }
      });
    };

    if (insides.length === 0) {
      callback(null);
    } else {
      callback(null, [new Error("GE_P_INNER_RINGS_NESTED: One or more interior rings are located completely inside another interior ring"), insides]);
    }
  };
};

var GE_P_ORIENTATION_RINGS_SAME = function(rings) {
  // The interior rings must have the opposite direction (clockwise vs
  // counterclockwise) when viewed from a given point-of-view. When the polygon
  // is used as a bounding surface of a shell, then the rings have to have a
  // specified orientation (see GE_S_POLYGON_WRONG_ORIENTATION /
  // GE_S_ALL_POLYGONS_WRONG_ORIENTATION).
  //
  // Example: https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/raw/master/errors/figs/208.png

  return function(callback) {
    var exteriorPoints = citygmlPoints(rings.exterior[0]);
    var exteriorPoints2d = points3dto2d(exteriorPoints, false);
    var exteriorPolygon = polygonjs(exteriorPoints2d.points);
    var exteriorWising = exteriorPolygon.winding();

    var interiors = rings.interior;

    // Pass immediately if no interior rings
    if (!interiors || interiors.length === 0) {
      callback(null);
      return;
    }

    var wisingDelta = true;
    var matches = [];

    _.each(interiors, function(interiorXML) {
      var interiorPoints = citygmlPoints(interiorXML);

      // Pass in external polygon origin for 2D coordinates
      var interiorPoints2d = points3dto2d(interiorPoints, false, exteriorPoints2d.state);

      var interiorPolygon = polygonjs(interiorPoints2d.points);
      var interiorWising = interiorPolygon.winding();

      if (interiorWising === exteriorWising) {
        matches.push([exteriorPoints2d.points, interiorPoints2d.points]);
      }
    });

    if (matches.length === 0) {
      callback(null);
    } else {
      callback(null, [new Error("GE_P_ORIENTATION_RINGS_SAME: The interior rings must have the opposite direction when viewed from a given point-of-view"), matches]);
    }
  };
};

// TODO: Place into own module as this is used in polygons-to-obj and
// citygml-validate-shell too
// TODO: Double-check that this is returning correct normal (not reversed)
var normalUnit = function(p1, p2, p3) {
  // Clone original points so we don't modify originals
  var cp1 = _.clone(p1);
  var cp2 = _.clone(p2);
  var cp3 = _.clone(p3);

  // http://stackoverflow.com/questions/8135260/normal-vector-to-a-plane
  var nx = (cp2[1] - cp1[1])*(cp3[2] - cp1[2]) - (cp2[2] - cp1[2])*(cp3[1] - cp1[1]);
  var ny = (cp2[2] - cp1[2])*(cp3[0] - cp1[0]) - (cp2[0] - cp1[0])*(cp3[2] - cp1[2]);
  var nz = (cp2[0] - cp1[0])*(cp3[1] - cp1[1]) - (cp2[1] - cp1[1])*(cp3[0] - cp1[0]);

  // Vector length
  // http://www.lighthouse3d.com/opengl/terrain/index.php3?normals
  var length = Math.sqrt(nx*nx + ny*ny + nz*nz);

  // Return normals in unit length
  var normals = [nx/length, ny/length, nz/length];

  return normals;
};

module.exports = citygmlValidatePolygon;
