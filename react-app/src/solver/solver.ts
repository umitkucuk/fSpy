import { CalibrationSettings1VP, CalibrationSettings2VP, PrincipalPointMode2VP, Axis } from "../types/calibration-settings";
import { ControlPointsState1VP, ControlPointsState2VP, VanishingPointControlState } from "../types/control-points-state";
import { ImageState } from "../types/image-state";
import MathUtil from "./math-util";
import Point2D from "./point-2d";
import Transform from "./transform";
import Vector3D from "./vector-3d";
import CoordinatesUtil, { ImageCoordinateFrame } from "./coordinates-util";
import { SolverResult } from "./solver-result";
import { defaultSolverResult } from "../defaults/solver-result";


/*
The solver handles estimation of focal length and camera orientation
from input line segments. All sections numbers, equations numbers etc
refer to "Using Vanishing Points for Camera Calibration and Coarse 3D Reconstruction
from a Single Image" by E. Guillou, D. Meneveaux, E. Maisel, K. Bouatouch.
(http://www.irisa.fr/prive/kadi/Reconstruction/paper.ps.gz).
*/
export default class Solver {

  static solve1VP(
    settings: CalibrationSettings1VP,
    controlPoints: ControlPointsState1VP,
    image: ImageState
  ): SolverResult {
    let result = this.blankSolverResult()

    let errors = this.validateImage(image)
    if (errors.length > 0) {
      result.errors = errors
      return result
    }

    let inputVanishingPoints = this.computeVanishingPointsFromControlPoints(
      image,
      controlPoints.vanishingPoints,
      errors
    )

    if (!inputVanishingPoints) {
      result.errors = errors
      return result
    }

    result.cameraTransform = new Transform()
    result.vanishingPoints = [inputVanishingPoints[0], { x: 0, y: 0 }, { x: 0, y: 0 }]
    result.horizontalFieldOfView = 0
    result.verticalFieldOfView = 0
    result.relativeFocalLength = 0

    return result
  }

  static solve2VP(
    settings: CalibrationSettings2VP,
    controlPoints: ControlPointsState2VP,
    image: ImageState
  ): SolverResult {
    let result = this.blankSolverResult()

    let errors = this.validateImage(image)
    if (errors.length > 0) {
      result.errors = errors
      return result
    }


    //TODO: clean up this cloning
    let vanishingPointControlStates: VanishingPointControlState[] = [
      {
        lineSegments: [
          [
            { ...controlPoints.vanishingPoints[0].lineSegments[0][0] },
            { ...controlPoints.vanishingPoints[0].lineSegments[0][1] }
          ],
          [
            { ...controlPoints.vanishingPoints[0].lineSegments[1][0] },
            { ...controlPoints.vanishingPoints[0].lineSegments[1][1] }
          ]
        ]
      },
      {
        lineSegments: [
          [
            { ...controlPoints.vanishingPoints[1].lineSegments[0][0] },
            { ...controlPoints.vanishingPoints[1].lineSegments[0][1] }
          ],
          [
            { ...controlPoints.vanishingPoints[0].lineSegments[1][0] },
            { ...controlPoints.vanishingPoints[0].lineSegments[1][1] }
          ]
        ]
      }
    ]

    if (settings.quadModeEnabled) {
      vanishingPointControlStates[1].lineSegments[0][0] = controlPoints.vanishingPoints[0].lineSegments[1][0]
      vanishingPointControlStates[1].lineSegments[0][1] = controlPoints.vanishingPoints[0].lineSegments[0][0]
      vanishingPointControlStates[1].lineSegments[1][0] = controlPoints.vanishingPoints[0].lineSegments[1][1]
      vanishingPointControlStates[1].lineSegments[1][1] = controlPoints.vanishingPoints[0].lineSegments[0][1]
    }

    //Compute the two input vanishing points from the provided control points
    let inputVanishingPoints = this.computeVanishingPointsFromControlPoints(
      image,
      controlPoints.vanishingPoints,
      errors
    )

    if (!inputVanishingPoints) {
      result.errors = errors
      return result
    }

    //Get the principal point

    let principalPoint = { x: 0, y: 0 }
    switch (settings.principalPointMode) {
      case PrincipalPointMode2VP.Manual:
        principalPoint = CoordinatesUtil.convert(
          controlPoints.principalPoint,
          ImageCoordinateFrame.Relative,
          ImageCoordinateFrame.ImagePlane,
          image.width!,
          image.height!
        )
        break
      case PrincipalPointMode2VP.FromThirdVanishingPoint:
        let vanishingPointz = this.computeVanishingPointsFromControlPoints(image, [controlPoints.vanishingPoints[2]], errors)
        if (vanishingPointz) {
          let thirdVanishingPoint = vanishingPointz[0]
          principalPoint = MathUtil.triangleOrthoCenter(
            inputVanishingPoints[0], inputVanishingPoints[1], thirdVanishingPoint
          )
        }
        break
    }

    if (errors.length > 0) {
      result.errors = errors
      return result
    }

    result.principalPoint = principalPoint
    result.vanishingPoints = [
      inputVanishingPoints[0],
      inputVanishingPoints[1],
      MathUtil.thirdTriangleVertex(
        inputVanishingPoints[0],
        inputVanishingPoints[1],
        principalPoint
      )
    ]

    let fRelative = this.computeFocalLength(
      inputVanishingPoints[0], inputVanishingPoints[1], result.principalPoint
    )! //TODO: check for null
    result.relativeFocalLength = fRelative

    let cameraTransform = this.computeCameraRotationMatrix(
      inputVanishingPoints[0], inputVanishingPoints[1], fRelative, result.principalPoint
    )

    //Assign axes to vanishing point
    let basisChangeTransform = new Transform()
    let row1 = this.axisVector(settings.vanishingPointAxes[0])
    let row2 = this.axisVector(settings.vanishingPointAxes[1])
    let row3 = row1.cross(row2)
    basisChangeTransform.matrix[0][0] = row1.x
    basisChangeTransform.matrix[0][1] = row1.y
    basisChangeTransform.matrix[0][2] = row1.z
    basisChangeTransform.matrix[1][0] = row2.x
    basisChangeTransform.matrix[1][1] = row2.y
    basisChangeTransform.matrix[1][2] = row2.z
    basisChangeTransform.matrix[2][0] = row3.x
    basisChangeTransform.matrix[2][1] = row3.y
    basisChangeTransform.matrix[2][2] = row3.z

    result.cameraTransform = basisChangeTransform.leftMultiplied(cameraTransform)

    result.vanishingPointAxes = [
      settings.vanishingPointAxes[0],
      settings.vanishingPointAxes[1],
      this.vectorAxis(row3)
    ]

    result.horizontalFieldOfView = this.computeFieldOfView(
      image.width!,
      image.height!,
      fRelative,
      false
    )
    result.verticalFieldOfView = this.computeFieldOfView(
      image.width!,
      image.height!,
      fRelative,
      true
    )


    //TODO: FIX THIS
    let lol = CoordinatesUtil.convert(
      {
        x: controlPoints.origin.x,
        y: controlPoints.origin.y
      },
      ImageCoordinateFrame.Relative,
      ImageCoordinateFrame.ImagePlane,
      image.width!,
      image.height!
    )

    let k = Math.tan(0.5 * result.horizontalFieldOfView)
    let lolz = new Vector3D(
      k * (lol.x - result.principalPoint.x),
      k * (lol.y - result.principalPoint.y),
      -1
    )

    result.cameraTransform.matrix[0][3] = 10 * lolz.x
    result.cameraTransform.matrix[1][3] = 10 * lolz.y
    result.cameraTransform.matrix[2][3] = 10 * lolz.z


    if (Math.abs(cameraTransform.determinant - 1) > 1e-7) {
      result.warnings.push("Unreliable camera transform, determinant " + cameraTransform.determinant.toFixed(5))
    }

    return result
  }

  static computeFieldOfView(
    imageWidth: number,
    imageHeight: number,
    fRelative: number,
    vertical: boolean
  ): number {
    let aspectRatio = imageWidth / imageHeight
    let d = 2
    if (aspectRatio < 1) {
      //tall image
      if (!vertical) {
        d = 2 * aspectRatio
      }
    }
    else {
      //wide image
      if (vertical) {
        d = 2 / aspectRatio
      }
    }

    return 2 * Math.atan(d / (2 * fRelative))

  }

  /**
   * Computes the focal length based on two vanishing points and a center of projection.
   * See 3.2 "Determining the focal length from a single image"
   * @param Fu the first vanishing point in image plane coordinates.
   * @param Fv the second vanishing point in image plane coordinates.
   * @param P the center of projection in image plane coordinates.
   * @returns The relative focal length.
   */
  static computeFocalLength(Fu: Point2D, Fv: Point2D, P: Point2D): number | null {
    //compute Puv, the orthogonal projection of P onto FuFv
    let dirFuFv = new Vector3D(Fu.x - Fv.x, Fu.y - Fv.y).normalized()
    let FvP = new Vector3D(P.x - Fv.x, P.y - Fv.y)
    let proj = dirFuFv.dot(FvP)
    let Puv = {
      x: proj * dirFuFv.x + Fv.x,
      y: proj * dirFuFv.y + Fv.y
    }

    let PPuv = new Vector3D(P.x - Puv.x, P.y - Puv.y).length
    let FvPuv = new Vector3D(Fv.x - Puv.x, Fv.y - Puv.y).length
    let FuPuv = new Vector3D(Fu.x - Puv.x, Fu.y - Puv.y).length

    let fSq = FvPuv * FuPuv - PPuv * PPuv

    if (fSq <= 0) {
      return null
    }

    return Math.sqrt(fSq)
  }
  /**
   * Computes the camera rotation matrix based on two vanishing points
   * and a focal length as in section 3.3 "Computing the rotation matrix".
   * @param Fu the first vanishing point in normalized image coordinates.
   * @param Fv the second vanishing point in normalized image coordinates.
   * @param f the relative focal length.
   * @param P the principal point
   * @returns The matrix Moc
   */
  static computeCameraRotationMatrix(Fu: Point2D, Fv: Point2D, f: number, P: Point2D): Transform {
    //
    let OFu = new Vector3D(Fu.x - P.x, Fu.y - P.y, -f)
    //
    let OFv = new Vector3D(Fv.x - P.x, Fv.y - P.y, -f)

    let s1 = OFu.length
    let upRc = OFu.normalized()

    let s2 = OFv.length
    let vpRc = OFv.normalized()

    let wpRc = upRc.cross(vpRc)

    let M = new Transform()
    M.matrix[0][0] = OFu.x / s1
    M.matrix[0][1] = OFv.x / s2
    M.matrix[0][2] = wpRc.x

    M.matrix[1][0] = OFu.y / s1
    M.matrix[1][1] = OFv.y / s2
    M.matrix[1][2] = wpRc.y

    M.matrix[2][0] = -f / s1
    M.matrix[2][1] = -f / s2
    M.matrix[2][2] = wpRc.z

    return M
  }

  private static axisVector(axis: Axis): Vector3D {
    switch (axis) {
      case Axis.NegativeX:
        return new Vector3D(-1, 0, 0)
      case Axis.PositiveX:
        return new Vector3D(1, 0, 0)
      case Axis.NegativeY:
        return new Vector3D(0, -1, 0)
      case Axis.PositiveY:
        return new Vector3D(0, 1, 0)
      case Axis.NegativeZ:
        return new Vector3D(0, 0, -1)
      case Axis.PositiveZ:
        return new Vector3D(0, 0, 1)
    }
  }

  private static vectorAxis(vector:Vector3D):Axis {
    if (vector.x == 0 && vector.y == 0) {
      return vector.z > 0 ? Axis.PositiveZ : Axis.NegativeZ
    }
    else if (vector.x == 0 && vector.z == 0) {
      return vector.y > 0 ? Axis.PositiveY : Axis.NegativeY
    }
    else if (vector.y == 0 && vector.z == 0) {
      return vector.x > 0 ? Axis.PositiveX : Axis.NegativeX
    }

    throw "Invalid axis vector"
  }

  private static validateImage(image: ImageState): string[] {
    let errors: string[] = []
    if (image.width == null || image.height == null) {
      errors.push("No image loaded")
    }
    return errors
  }

  private static computeVanishingPointsFromControlPoints(
    image: ImageState,
    controlPointStates: VanishingPointControlState[],
    errors: string[]
  ): Point2D[] | null {
    let result: Point2D[] = []
    for (let i = 0; i < controlPointStates.length; i++) {
      let vanishingPoint = MathUtil.lineIntersection(
        controlPointStates[i].lineSegments[0],
        controlPointStates[i].lineSegments[1]
      )
      if (vanishingPoint) {
        result.push(
          CoordinatesUtil.convert(
            vanishingPoint,
            ImageCoordinateFrame.Relative,
            ImageCoordinateFrame.ImagePlane,
            image.width!,
            image.height!
          )
        )
      }
      else {
        errors.push("Failed to compute vanishing point")
      }
    }

    return errors.length == 0 ? result : null
  }

  /**
   * Creates a blank solver result to be populated by the solver
   */
  private static blankSolverResult(): SolverResult {
    let result = { ...defaultSolverResult }
    result.errors = []
    result.warnings = []
    return result
  }
}