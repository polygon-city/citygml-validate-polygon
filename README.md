# CityGML Validate Polygon

Validate a CityGML polygon against the [QIE suite](https://github.com/tudelft3d/CityGML-QIE-3Dvalidation/blob/master/errors/errors.md#polygon)

## Usage

```javascript
var citygmlPolygons = require("citygml-polygons");
var citygmlValidatePolygon = require("citygml-validate-polygon");

var xml = "..."; // Some CityGML
var polygons = citygmlPolygons(xml);

// Validate polygon as a whole
citygmlValidatePolygon(polygons[0], function(err, results) {
  _.each(results, function(vError) {
    // Should always be an error, but check anyway
    if (!vError || !vError[0]) {
      return;
    }

    // Output validation error name
    console.log(vError[0].message);
  });
});
```
