package com.example.ageestimator

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.example.ageestimator.databinding.ActivityMainBinding
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var cameraExecutor: ExecutorService
    private lateinit var ageEstimator: AgeEstimator
    private var imageCapture: ImageCapture? = null

    private val requestPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else {
                binding.resultText.text = "Потрібен дозвіл на камеру, щоб визначити вік"
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        ageEstimator = AgeEstimator(this)
        cameraExecutor = Executors.newSingleThreadExecutor()

        if (!ageEstimator.isModelLoaded) {
            binding.resultText.text =
                "Модель age_model.tflite не знайдена в assets.\nДодайте файл моделі — див. README.md"
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }

        binding.captureButton.setOnClickListener { takePhotoAndEstimate() }
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.previewView.surfaceProvider)
            }

            imageCapture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build()

            val cameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(this, cameraSelector, preview, imageCapture)
            } catch (e: Exception) {
                binding.resultText.text = "Помилка запуску камери: ${e.message}"
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun takePhotoAndEstimate() {
        val capture = imageCapture ?: return
        binding.resultText.text = "Аналізую..."

        capture.takePicture(cameraExecutor, object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                val bitmap = imageProxyToBitmap(image)
                image.close()
                detectFaceAndEstimateAge(bitmap)
            }

            override fun onError(exception: ImageCaptureException) {
                runOnUiThread {
                    binding.resultText.text = "Помилка знімку: ${exception.message}"
                }
            }
        })
    }

    private fun imageProxyToBitmap(image: ImageProxy): Bitmap {
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)

        // Фронтальна камера часто дає обернене/дзеркальне зображення — виправляємо поворот
        val matrix = Matrix()
        matrix.postRotate(image.imageInfo.rotationDegrees.toFloat())
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun detectFaceAndEstimateAge(bitmap: Bitmap) {
        val options = FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
            .build()
        val detector = FaceDetection.getClient(options)
        val inputImage = InputImage.fromBitmap(bitmap, 0)

        detector.process(inputImage)
            .addOnSuccessListener { faces ->
                if (faces.isEmpty()) {
                    runOnUiThread { binding.resultText.text = "Обличчя не знайдено. Спробуйте ще раз" }
                    return@addOnSuccessListener
                }

                val box = faces[0].boundingBox
                val left = box.left.coerceIn(0, bitmap.width - 1)
                val top = box.top.coerceIn(0, bitmap.height - 1)
                val width = box.width().coerceAtMost(bitmap.width - left)
                val height = box.height().coerceAtMost(bitmap.height - top)

                if (width <= 0 || height <= 0) {
                    runOnUiThread { binding.resultText.text = "Не вдалося обрізати обличчя" }
                    return@addOnSuccessListener
                }

                val faceBitmap = Bitmap.createBitmap(bitmap, left, top, width, height)
                val age = ageEstimator.estimateAge(faceBitmap)

                runOnUiThread {
                    binding.resultText.text = if (age != null) {
                        "Приблизний вік: $age років\n(орієнтовна оцінка, не точна)"
                    } else {
                        "Модель віку не завантажена. Додайте age_model.tflite в assets"
                    }
                }
            }
            .addOnFailureListener { e ->
                runOnUiThread { binding.resultText.text = "Помилка розпізнавання: ${e.message}" }
            }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        ageEstimator.close()
    }
}
